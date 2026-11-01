-- Phase 1 of failed-message management: record why each campaign message failed, work out each
-- contact's delivery status from those failures, and keep "Do Not Send" contacts out of campaigns.
-- Apply after 0024. Safe to rerun. Existing contacts, imports and the global opt-out list are untouched
-- (nothing here deletes or edits a contact; statuses are calculated, never stored on the contact).
--
-- Contact status (first match wins):
--   opt_out      phone is on the global opt-out list (opt_out_numbers; includes error 131050 via 0024)
--   do_not_send  131026 (undeliverable): until manually reactivated, review due after 30 days
--                131049 in 3+ DISTINCT campaigns within 90 days: until manually reactivated,
--                  review due 30 days after the latest failure
--                131056: temporary cooldown from the latest failure, by the number of 131056 failures
--                  in the 30 days up to it: 1st = 24h, 2nd = 72h, 3rd = 7 days, 4th+ = 14 days
--                  (the count starts again after 30 days without this error)
--   at_risk      has a 131049 failure in the last 90 days and has not engaged since it (stays eligible)
--   active       read a message, or sent us a message / tapped a reply button, in the last 30 days
--   other        none of the above
-- Account-level codes (131048 spam limit, 131047 outside the 24h window) are logged but never change a
-- contact's status. A manual reactivation ignores every failure recorded up to that moment.

create table if not exists public.contact_delivery_failures (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.whatsapp_campaigns(id),
  recipient_id uuid not null references public.whatsapp_campaign_recipients(id),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  wamid text not null,
  error_code text not null check (length(error_code) between 1 and 20),
  error_title text check (error_title is null or length(error_title) <= 500),
  failed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (wamid, error_code)
);

create index if not exists contact_delivery_failures_phone_idx
  on public.contact_delivery_failures (phone_e164, error_code, failed_at desc);
create index if not exists contact_delivery_failures_campaign_idx
  on public.contact_delivery_failures (campaign_id, error_code);

-- Manual review result: failures recorded up to reactivated_at no longer count for this number.
create table if not exists public.contact_failure_reactivations (
  phone_e164 text primary key check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  reactivated_at timestamptz not null default now(),
  reactivated_by uuid references auth.users(id),
  note text check (note is null or length(note) <= 500)
);

alter table public.contact_delivery_failures enable row level security;
alter table public.contact_failure_reactivations enable row level security;
revoke all on public.contact_delivery_failures, public.contact_failure_reactivations
  from public, anon, authenticated;
grant select on public.contact_delivery_failures, public.contact_failure_reactivations to service_role;

-- Record every failed campaign message (any error code) once, with the code Meta gave.
create or replace function public.record_campaign_delivery_failure()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := new.payload->'errors'->0->>'code';
begin
  if new.kind <> 'status' or new.provider_status is distinct from 'failed'
     or new.provider_message_id is null or v_code is null or length(v_code) > 20 then
    return new;
  end if;

  insert into public.contact_delivery_failures (
    campaign_id, recipient_id, phone_e164, wamid, error_code, error_title, failed_at)
  select campaign.id, recipient.id, recipient.recipient_e164, new.provider_message_id, v_code,
         left(coalesce(new.payload->'errors'->0->>'title', new.payload->'errors'->0->>'message'), 500),
         coalesce(new.event_timestamp, new.received_at)
  from public.whatsapp_campaign_recipients recipient
  join public.whatsapp_campaigns campaign on campaign.id = recipient.campaign_id
  where recipient.wamid = new.provider_message_id
    and campaign.waba_id = new.waba_id and campaign.phone_number_id = new.phone_number_id
    and recipient.recipient_e164 ~ '^\+[1-9][0-9]{7,14}$'
  limit 1
  on conflict (wamid, error_code) do nothing;
  return new;
exception when others then
  -- Never fail webhook receipt because of this log.
  raise warning 'campaign failure log skipped: %', sqlstate;
  return new;
end;
$$;

drop trigger if exists record_campaign_delivery_failure_trigger on public.meta_webhook_items;
create trigger record_campaign_delivery_failure_trigger
after insert on public.meta_webhook_items
for each row execute function public.record_campaign_delivery_failure();

-- Backfill from webhook events that were already received.
insert into public.contact_delivery_failures (
  campaign_id, recipient_id, phone_e164, wamid, error_code, error_title, failed_at)
select distinct on (i.provider_message_id, i.payload->'errors'->0->>'code')
       campaign.id, recipient.id, recipient.recipient_e164, i.provider_message_id,
       i.payload->'errors'->0->>'code',
       left(coalesce(i.payload->'errors'->0->>'title', i.payload->'errors'->0->>'message'), 500),
       coalesce(i.event_timestamp, i.received_at)
from public.meta_webhook_items i
join public.whatsapp_campaign_recipients recipient on recipient.wamid = i.provider_message_id
join public.whatsapp_campaigns campaign on campaign.id = recipient.campaign_id
  and campaign.waba_id = i.waba_id and campaign.phone_number_id = i.phone_number_id
where i.kind = 'status' and i.provider_status = 'failed'
  and i.payload->'errors'->0->>'code' is not null
  and length(i.payload->'errors'->0->>'code') <= 20
  and recipient.recipient_e164 ~ '^\+[1-9][0-9]{7,14}$'
order by i.provider_message_id, i.payload->'errors'->0->>'code', i.received_at
on conflict (wamid, error_code) do nothing;

-- One contact's status as of p_now (default: now). See the rules at the top of this file.
create or replace function public.contact_delivery_state(p_phone text, p_now timestamptz default now())
returns table (status text, reason text, hold_until timestamptz, review_due_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_reset timestamptz;
  v_last_1026 timestamptz;
  v_campaigns_1049 integer;
  v_last_1049 timestamptz;
  v_last_1056 timestamptz;
  v_count_1056 integer;
  v_cooldown interval;
  v_engaged timestamptz;
begin
  if exists (select 1 from public.opt_out_numbers n where n.phone_e164 = p_phone and n.released_at is null) then
    return query select 'opt_out'::text, 'opt_out_list'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select coalesce(max(r.reactivated_at), '-infinity'::timestamptz) into v_reset
  from public.contact_failure_reactivations r where r.phone_e164 = p_phone;

  select max(f.failed_at) into v_last_1026
  from public.contact_delivery_failures f
  where f.phone_e164 = p_phone and f.error_code = '131026' and f.failed_at > v_reset and f.failed_at <= p_now;
  if v_last_1026 is not null then
    return query select 'do_not_send'::text, 'undeliverable_131026'::text, null::timestamptz,
                        v_last_1026 + interval '30 days';
    return;
  end if;

  select count(distinct f.campaign_id), max(f.failed_at) into v_campaigns_1049, v_last_1049
  from public.contact_delivery_failures f
  where f.phone_e164 = p_phone and f.error_code = '131049' and f.failed_at > v_reset
    and f.failed_at <= p_now and f.failed_at > p_now - interval '90 days';
  if v_campaigns_1049 >= 3 then
    return query select 'do_not_send'::text, 'repeated_131049'::text, null::timestamptz,
                        v_last_1049 + interval '30 days';
    return;
  end if;

  select max(f.failed_at) into v_last_1056
  from public.contact_delivery_failures f
  where f.phone_e164 = p_phone and f.error_code = '131056' and f.failed_at > v_reset and f.failed_at <= p_now;
  if v_last_1056 is not null then
    select count(*) into v_count_1056
    from public.contact_delivery_failures f
    where f.phone_e164 = p_phone and f.error_code = '131056' and f.failed_at > v_reset
      and f.failed_at <= v_last_1056 and f.failed_at > v_last_1056 - interval '30 days';
    v_cooldown := case when v_count_1056 <= 1 then interval '24 hours'
                       when v_count_1056 = 2 then interval '72 hours'
                       when v_count_1056 = 3 then interval '7 days'
                       else interval '14 days' end;
    if p_now < v_last_1056 + v_cooldown then
      return query select 'do_not_send'::text, 'cooldown_131056'::text, v_last_1056 + v_cooldown,
                          null::timestamptz;
      return;
    end if;
  end if;

  select max(t.at) into v_engaged from (
    select r.last_status_at as at
    from public.whatsapp_campaign_recipients r
    where r.recipient_e164 = p_phone and r.delivery_status = 'read' and r.last_status_at <= p_now
    union all
    select coalesce(i.event_timestamp, i.received_at)
    from public.meta_webhook_items i
    where i.kind = 'message' and i.payload->>'from' = substring(p_phone from 2)
      and coalesce(i.event_timestamp, i.received_at) <= p_now
  ) t;

  if v_last_1049 is not null and (v_engaged is null or v_engaged < v_last_1049) then
    return query select 'at_risk'::text, 'meta_marketing_limit_131049'::text, null::timestamptz, null::timestamptz;
  elsif v_engaged is not null and v_engaged >= p_now - interval '30 days' then
    return query select 'active'::text, 'engaged_last_30_days'::text, null::timestamptz, null::timestamptz;
  else
    return query select 'other'::text, null::text, null::timestamptz, null::timestamptz;
  end if;
end;
$$;

create or replace view public.contact_delivery_status as
select c.id as contact_id, c.phone_e164, s.status, s.reason, s.hold_until, s.review_due_at
from public.contacts c
cross join lateral public.contact_delivery_state(c.phone_e164) s;

-- The five Contacts cards. opt_out counts the global list itself (numbers need not be saved contacts).
create or replace function public.contact_status_counts()
returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'total', (select count(*) from public.contacts),
    'active', count(*) filter (where status = 'active'),
    'at_risk', count(*) filter (where status = 'at_risk'),
    'do_not_send', count(*) filter (where status = 'do_not_send'),
    'opt_out', (select count(*) from public.opt_out_numbers where released_at is null))
  from public.contact_delivery_status;
$$;

-- Manual review: a person confirms the number is fine, so earlier failures stop counting.
create or replace function public.reactivate_contact_delivery(
  p_phone text, p_actor_user_id uuid, p_note text default null
) returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' or p_actor_user_id is null
     or length(coalesce(p_note, '')) > 500 then
    raise exception 'Invalid reactivation';
  end if;
  insert into public.contact_failure_reactivations (phone_e164, reactivated_at, reactivated_by, note)
  values (p_phone, now(), p_actor_user_id, p_note)
  on conflict (phone_e164) do update
    set reactivated_at = now(), reactivated_by = excluded.reactivated_by, note = excluded.note;
  return true;
end;
$$;

-- Campaign eligibility (draft time and send time): 0020's rules plus "not Do Not Send".
create or replace function public.can_send_whatsapp_marketing(
  p_contact_id uuid, p_waba_id text, p_phone_number_id text
) returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    p_waba_id is not null and length(p_waba_id) > 0
    and p_phone_number_id is not null and length(p_phone_number_id) > 0
    and exists (
      select 1 from public.contacts c
      where c.id = p_contact_id
        and c.campaign_active
        and not exists (
          select 1 from public.contact_delivery_state(c.phone_e164) as hold
          where hold.status = 'do_not_send')
        and not exists (
          select 1 from public.opt_out_numbers n
          where n.phone_e164 = c.phone_e164 and n.released_at is null)
        and not exists (
          select 1 from public.contact_marketing_suppressions s
          where s.phone_e164 = c.phone_e164 and s.released_at is null)
        and not exists (
          select 1 from public.meta_opt_outs o
          where o.waba_id = p_waba_id and o.phone_number_id = p_phone_number_id
            and o.identity_type = 'whatsapp_from'
            and o.identity_value in (c.phone_e164, substring(c.phone_e164 from 2)))
    ), false);
$$;

revoke all on function public.record_campaign_delivery_failure() from public, anon, authenticated;
revoke all on function public.contact_delivery_state(text, timestamptz) from public, anon, authenticated;
revoke all on function public.contact_status_counts() from public, anon, authenticated;
revoke all on function public.reactivate_contact_delivery(text, uuid, text) from public, anon, authenticated;
revoke all on public.contact_delivery_status from public, anon, authenticated;
grant execute on function public.contact_delivery_state(text, timestamptz) to service_role;
grant execute on function public.contact_status_counts() to service_role;
grant execute on function public.reactivate_contact_delivery(text, uuid, text) to service_role;
grant select on public.contact_delivery_status to service_role;
