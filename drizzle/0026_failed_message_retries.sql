-- Phase 2 of failed-message management: retry failed messages (131049), record every attempt,
-- warn about business-number restrictions (131048), and keep sends within the existing throttle.
-- Apply after 0025. Safe to rerun. Existing contacts, imports and the opt-out list are untouched.
--
-- Retry rules (error 131049, Meta's marketing limit for one person):
--   * Never immediate. Delays are per campaign, strictly increasing, default 24h, 72h, 7 days.
--     Attempt n is scheduled `delays[n]` hours after the previous failure.
--   * At most 3 retries per original message, automatic and manual combined. Every attempt is stored
--     in campaign_message_retries and every failed attempt in contact_delivery_failures.
--   * After the 3rd retry fails the original message is "exhausted": retries stop and the contact is
--     "Do Not Send - Manual Review" (retry_exhausted) until someone reactivates it. Never an opt-out.
--   * A retry that is delivered/read marks the original message recovered (the campaign's delivered
--     count goes up; the original failure stays in the history).
--   * A retry is claimed once (in_flight) and is never claimed again, so it cannot be sent twice.
--   * Auto retry is OFF by default and is switched on per campaign.

alter table public.whatsapp_campaigns
  add column if not exists auto_retry boolean not null default false,
  add column if not exists retry_delays_hours integer[] not null default array[24, 72, 168];

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_campaigns_retry_delays_check') then
    alter table public.whatsapp_campaigns add constraint whatsapp_campaigns_retry_delays_check
      check (cardinality(retry_delays_hours) = 3
             and retry_delays_hours[1] >= 1 and retry_delays_hours[1] < retry_delays_hours[2]
             and retry_delays_hours[2] < retry_delays_hours[3] and retry_delays_hours[3] <= 720);
  end if;
end $$;

create table if not exists public.campaign_message_retries (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.whatsapp_campaigns(id),
  recipient_id uuid not null references public.whatsapp_campaign_recipients(id),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  original_wamid text not null,
  attempt_number integer not null check (attempt_number between 1 and 3),
  trigger text not null check (trigger in ('auto', 'manual')),
  scheduled_for timestamptz not null,
  state text not null default 'pending'
    check (state in ('pending', 'in_flight', 'accepted', 'rejected', 'uncertain', 'skipped', 'canceled')),
  wamid text unique,
  delivery_status text check (delivery_status in ('sent', 'delivered', 'read', 'failed')),
  error_code text check (error_code is null or length(error_code) <= 20),
  error_summary text check (error_summary is null or length(error_summary) <= 500),
  requested_by uuid references auth.users(id),
  claimed_at timestamptz,
  finished_at timestamptz,
  last_status_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (recipient_id, attempt_number)
);

create index if not exists campaign_message_retries_due_idx
  on public.campaign_message_retries (scheduled_for, id) where state = 'pending';
create index if not exists campaign_message_retries_campaign_idx
  on public.campaign_message_retries (campaign_id, state);

alter table public.contact_delivery_failures
  add column if not exists retry_id uuid references public.campaign_message_retries(id),
  add column if not exists attempt_number integer not null default 0 check (attempt_number between 0 and 3);

create table if not exists public.sender_alerts (
  id uuid primary key default gen_random_uuid(),
  waba_id text not null,
  phone_number_id text not null,
  code text not null check (length(code) between 1 and 20),
  title text check (title is null or length(title) <= 500),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1 check (occurrences >= 1),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id)
);
create unique index if not exists sender_alerts_open_idx
  on public.sender_alerts (waba_id, phone_number_id, code) where resolved_at is null;

alter table public.campaign_message_retries enable row level security;
alter table public.sender_alerts enable row level security;
revoke all on public.campaign_message_retries, public.sender_alerts from public, anon, authenticated;
grant select on public.campaign_message_retries, public.sender_alerts to service_role;

-- A business-number level problem (131048). Pauses every running or scheduled campaign of that sender
-- and leaves one open alert until a person resolves it.
create or replace function public.raise_sender_alert(
  p_waba_id text, p_phone_number_id text, p_code text, p_title text
) returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(p_waba_id, '') is null or nullif(p_phone_number_id, '') is null
     or nullif(p_code, '') is null or length(p_code) > 20 then
    raise exception 'Invalid sender alert';
  end if;
  insert into public.sender_alerts (waba_id, phone_number_id, code, title)
  values (p_waba_id, p_phone_number_id, p_code, left(p_title, 500))
  on conflict (waba_id, phone_number_id, code) where resolved_at is null do update
    set last_seen_at = now(), occurrences = public.sender_alerts.occurrences + 1,
        title = coalesce(excluded.title, public.sender_alerts.title);
  perform public.worker_pause_whatsapp_campaign(
    c.id, left('Meta restriction on the business number (' || p_code || ')', 120))
  from public.whatsapp_campaigns c
  where c.waba_id = p_waba_id and c.phone_number_id = p_phone_number_id
    and c.state in ('scheduled', 'running');
end;
$$;

create or replace function public.resolve_sender_alert(p_alert_id uuid, p_actor_user_id uuid)
returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_alert_id is null or p_actor_user_id is null then raise exception 'Invalid alert resolution'; end if;
  update public.sender_alerts set resolved_at = now(), resolved_by = p_actor_user_id
  where id = p_alert_id and resolved_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create or replace function public.sender_alert_from_failure()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_campaign public.whatsapp_campaigns;
begin
  if new.error_code <> '131048' then return new; end if;
  select * into v_campaign from public.whatsapp_campaigns where id = new.campaign_id;
  if found then
    perform public.raise_sender_alert(v_campaign.waba_id, v_campaign.phone_number_id, '131048', new.error_title);
  end if;
  return new;
exception when others then
  raise warning 'sender alert skipped: %', sqlstate;
  return new;
end;
$$;

drop trigger if exists sender_alert_from_failure_trigger on public.contact_delivery_failures;
create trigger sender_alert_from_failure_trigger
after insert on public.contact_delivery_failures
for each row execute function public.sender_alert_from_failure();

-- Queue one retry for a recipient whose original message failed with 131049.
-- Returns false when nothing was queued (already active, recovered, 3 used, not a 131049 failure).
create or replace function public.schedule_campaign_retry(
  p_recipient_id uuid, p_trigger text, p_run_at timestamptz, p_actor_user_id uuid
) returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r public.whatsapp_campaign_recipients;
  v_next integer;
  v_id uuid;
begin
  if p_trigger not in ('auto', 'manual') or p_run_at is null then raise exception 'Invalid retry request'; end if;
  select * into r from public.whatsapp_campaign_recipients where id = p_recipient_id for update;
  if not found or r.wamid is null then return false; end if;
  if r.delivery_status in ('delivered', 'read') then return false; end if;
  if not exists (select 1 from public.contact_delivery_failures f
                 where f.recipient_id = r.id and f.error_code = '131049' and f.attempt_number = 0) then
    return false;
  end if;
  if exists (select 1 from public.campaign_message_retries m
             where m.recipient_id = r.id
               and (m.state in ('pending', 'in_flight')
                    or (m.state = 'accepted' and coalesce(m.delivery_status, 'sent') = 'sent'))) then
    return false;
  end if;
  select coalesce(max(m.attempt_number), 0) + 1 into v_next
  from public.campaign_message_retries m
  where m.recipient_id = r.id and m.state in ('accepted', 'rejected', 'uncertain');
  if v_next > 3 then return false; end if;

  insert into public.campaign_message_retries (
    campaign_id, recipient_id, phone_e164, original_wamid, attempt_number, trigger, scheduled_for, requested_by)
  values (r.campaign_id, r.id, r.recipient_e164, r.wamid, v_next, p_trigger, greatest(p_run_at, now()), p_actor_user_id)
  on conflict (recipient_id, attempt_number) do update
    set state = 'pending', trigger = excluded.trigger, scheduled_for = excluded.scheduled_for,
        requested_by = excluded.requested_by, claimed_at = null, finished_at = null,
        error_summary = null, updated_at = now()
    where public.campaign_message_retries.state in ('canceled', 'skipped')
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- Log every failed campaign message, original or retry, with Meta's error code. Retries stay in the
-- history. A failed 131049 schedules the next automatic retry when the campaign has auto retry on.
create or replace function public.record_campaign_delivery_failure()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := new.payload->'errors'->0->>'code';
  v_title text := left(coalesce(new.payload->'errors'->0->>'title', new.payload->'errors'->0->>'message'), 500);
  v_failed_at timestamptz := coalesce(new.event_timestamp, new.received_at);
  v_campaign uuid;
  v_recipient uuid;
  v_phone text;
  v_auto boolean;
  v_delays integer[];
  v_retry uuid;
  v_attempt integer := 0;
  v_final text;
  v_inserted uuid;
begin
  if new.kind <> 'status' or new.provider_status is distinct from 'failed'
     or new.provider_message_id is null or v_code is null or length(v_code) > 20 then
    return new;
  end if;

  select c.id, r.id, r.recipient_e164, c.auto_retry, c.retry_delays_hours
  into v_campaign, v_recipient, v_phone, v_auto, v_delays
  from public.whatsapp_campaign_recipients r
  join public.whatsapp_campaigns c on c.id = r.campaign_id
  where r.wamid = new.provider_message_id
    and c.waba_id = new.waba_id and c.phone_number_id = new.phone_number_id
    and r.recipient_e164 ~ '^\+[1-9][0-9]{7,14}$'
  limit 1;

  if not found then
    select c.id, m.recipient_id, m.phone_e164, c.auto_retry, c.retry_delays_hours, m.id, m.attempt_number
    into v_campaign, v_recipient, v_phone, v_auto, v_delays, v_retry, v_attempt
    from public.campaign_message_retries m
    join public.whatsapp_campaigns c on c.id = m.campaign_id
    where m.wamid = new.provider_message_id
      and c.waba_id = new.waba_id and c.phone_number_id = new.phone_number_id
    limit 1;
    if not found then return new; end if;

    -- Delivered/read beats failed; otherwise failed beats sent.
    update public.campaign_message_retries
    set delivery_status = case when delivery_status in ('delivered', 'read') then delivery_status else 'failed' end,
        error_code = case when delivery_status in ('delivered', 'read') then error_code else v_code end,
        last_status_at = greatest(coalesce(last_status_at, '-infinity'::timestamptz), v_failed_at),
        updated_at = now()
    where id = v_retry
    returning delivery_status into v_final;
  end if;

  insert into public.contact_delivery_failures (
    campaign_id, recipient_id, phone_e164, wamid, error_code, error_title, failed_at, retry_id, attempt_number)
  values (v_campaign, v_recipient, v_phone, new.provider_message_id, v_code, v_title, v_failed_at, v_retry, v_attempt)
  on conflict (wamid, error_code) do nothing
  returning id into v_inserted;
  if v_inserted is null then return new; end if;

  if v_code = '131049' and v_auto and v_attempt < 3 and (v_retry is null or v_final = 'failed') then
    perform public.schedule_campaign_retry(
      v_recipient, 'auto', v_failed_at + make_interval(hours => v_delays[v_attempt + 1]), null);
  end if;
  return new;
exception when others then
  -- Never fail webhook receipt because of this log.
  raise warning 'campaign failure log skipped: %', sqlstate;
  return new;
end;
$$;

-- Sent / delivered / read statuses for a retry's own message id. A delivered or read retry recovers
-- the original message: the campaign recipient now counts as delivered.
create or replace function public.project_campaign_retry_status()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz := coalesce(new.event_timestamp, new.received_at);
  v_retry public.campaign_message_retries;
begin
  if new.kind <> 'status' or new.provider_message_id is null
     or new.provider_status not in ('sent', 'delivered', 'read') then
    return new;
  end if;

  update public.campaign_message_retries m
  set delivery_status = case
        when m.delivery_status is null then new.provider_status
        when new.provider_status = 'read' then 'read'
        when new.provider_status = 'delivered' and m.delivery_status <> 'read' then 'delivered'
        when new.provider_status = 'sent' and m.delivery_status is null then 'sent'
        else m.delivery_status end,
      error_code = case when new.provider_status in ('delivered', 'read') then null else m.error_code end,
      last_status_at = greatest(coalesce(m.last_status_at, '-infinity'::timestamptz), v_at),
      updated_at = now()
  where m.wamid = new.provider_message_id
  returning * into v_retry;

  if found and v_retry.delivery_status in ('delivered', 'read') then
    update public.whatsapp_campaign_recipients r
    set delivery_status = case when r.delivery_status = 'read' then 'read' else v_retry.delivery_status end,
        last_status_at = greatest(coalesce(r.last_status_at, '-infinity'::timestamptz), v_at),
        updated_at = now()
    where r.id = v_retry.recipient_id and r.delivery_status is distinct from 'read'
      and (r.delivery_status is null or r.delivery_status in ('sent', 'failed', 'delivered'));
  end if;
  return new;
exception when others then
  raise warning 'campaign retry status skipped: %', sqlstate;
  return new;
end;
$$;

drop trigger if exists project_campaign_retry_status_trigger on public.meta_webhook_items;
create trigger project_campaign_retry_status_trigger
after insert on public.meta_webhook_items
for each row execute function public.project_campaign_retry_status();

drop trigger if exists record_campaign_delivery_failure_trigger on public.meta_webhook_items;
create trigger record_campaign_delivery_failure_trigger
after insert on public.meta_webhook_items
for each row execute function public.record_campaign_delivery_failure();

-- Worker functions ---------------------------------------------------------------------------

create or replace function public.claim_campaign_retries(p_limit integer)
returns setof public.campaign_message_retries language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 then raise exception 'Invalid retry claim limit'; end if;

  update public.campaign_message_retries m
  set state = 'canceled', finished_at = now(), updated_at = now()
  from public.whatsapp_campaigns c
  where c.id = m.campaign_id and c.state = 'canceled' and m.state = 'pending';

  return query
  with chosen as (
    select m.id
    from public.campaign_message_retries m
    join public.whatsapp_campaigns c on c.id = m.campaign_id
    where m.state = 'pending' and m.scheduled_for <= now() and c.state in ('running', 'completed')
    order by m.scheduled_for, m.id
    limit p_limit for update of m skip locked
  )
  update public.campaign_message_retries m
  set state = 'in_flight', claimed_at = now(), updated_at = now()
  from chosen where m.id = chosen.id
  returning m.*;
end;
$$;

create or replace function public.campaign_retry_send_gate(p_retry_id uuid)
returns text language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  m public.campaign_message_retries;
  c public.whatsapp_campaigns;
  r public.whatsapp_campaign_recipients;
begin
  select * into m from public.campaign_message_retries where id = p_retry_id;
  if not found or m.state <> 'in_flight' then return 'inactive'; end if;
  select * into c from public.whatsapp_campaigns where id = m.campaign_id;
  select * into r from public.whatsapp_campaign_recipients where id = m.recipient_id;
  if c.state = 'canceled' then return 'canceled'; end if;
  if c.state not in ('running', 'completed') then return 'deferred'; end if;
  if exists (select 1 from public.sender_alerts a
             where a.waba_id = c.waba_id and a.phone_number_id = c.phone_number_id
               and a.code = '131048' and a.resolved_at is null) then
    return 'deferred';
  end if;
  if r.delivery_status in ('delivered', 'read') then return 'skipped'; end if;
  if not public.can_send_whatsapp_marketing(r.contact_id, c.waba_id, c.phone_number_id) then
    return 'suppressed';
  end if;
  return 'allowed';
end;
$$;

create or replace function public.record_campaign_retry_result(
  p_retry_id uuid, p_state text, p_wamid text, p_error_summary text
) returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_state not in ('accepted', 'rejected', 'uncertain', 'skipped', 'canceled', 'deferred')
     or (p_state = 'accepted' and nullif(p_wamid, '') is null) then
    raise exception 'Invalid retry result';
  end if;
  if p_state = 'deferred' then
    update public.campaign_message_retries
    set state = 'pending', scheduled_for = now() + interval '30 minutes', claimed_at = null,
        error_summary = left(p_error_summary, 500), updated_at = now()
    where id = p_retry_id and state = 'in_flight';
  else
    update public.campaign_message_retries
    set state = p_state, wamid = case when p_state = 'accepted' then p_wamid else wamid end,
        error_summary = left(p_error_summary, 500), finished_at = now(), updated_at = now()
    where id = p_retry_id and state = 'in_flight';
  end if;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- A claim that never reported back may or may not have reached Meta: never resend it.
create or replace function public.mark_stale_campaign_retries()
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  update public.campaign_message_retries
  set state = 'uncertain', finished_at = now(), updated_at = now(),
      error_summary = 'The send may or may not have reached WhatsApp. Check before retrying.'
  where state = 'in_flight' and claimed_at < now() - interval '10 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Due retries count as pending work, so the sender workflow keeps running or sleeps until they are due.
create or replace function public.campaign_worker_status()
returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'running_pending',
      exists (
        select 1 from public.whatsapp_campaign_recipients r
        join public.whatsapp_campaigns c on c.id = r.campaign_id
        where r.state = 'pending' and c.state = 'running')
      or exists (
        select 1 from public.campaign_message_retries m
        join public.whatsapp_campaigns c on c.id = m.campaign_id
        where m.state = 'pending' and m.scheduled_for <= now() and c.state in ('running', 'completed')),
    'in_flight',
      exists (select 1 from public.whatsapp_campaign_recipients where state = 'in_flight')
      or exists (select 1 from public.campaign_message_retries where state = 'in_flight'),
    'next_scheduled_at', least(
      (select min(scheduled_for) from public.whatsapp_campaigns where state = 'scheduled'),
      (select min(m.scheduled_for) from public.campaign_message_retries m
         join public.whatsapp_campaigns c on c.id = m.campaign_id
         where m.state = 'pending' and m.scheduled_for > now() and c.state in ('running', 'completed'))));
$$;

-- Retry sends use up the same throttle allowance as campaign sends.
create or replace view public.campaign_send_log as
select started_at as at from public.whatsapp_campaign_send_attempts
where state in ('in_flight', 'accepted', 'uncertain')
union all
select claimed_at as at from public.campaign_message_retries
where state in ('in_flight', 'accepted', 'uncertain') and claimed_at is not null;

create or replace function public.campaign_send_throttle(
  p_batch integer, p_cooldown_minutes integer
) returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_cooldown interval;
  v_last timestamptz;
  v_burst_start timestamptz;
  v_count integer;
begin
  if p_batch is null or p_batch not between 1 and 500
     or p_cooldown_minutes is null or p_cooldown_minutes not between 1 and 1440 then
    raise exception 'Invalid send throttle';
  end if;
  v_cooldown := make_interval(mins => p_cooldown_minutes);

  select max(at) into v_last from public.campaign_send_log;

  if v_last is null or now() >= v_last + v_cooldown then
    return jsonb_build_object('allowed', p_batch, 'wait_until', null);
  end if;

  select max(at) into v_burst_start
  from (
    select at, lag(at) over (order by at) as previous_at
    from public.campaign_send_log
    where at > now() - (v_cooldown * 2 + interval '2 days')
  ) as sends
  where previous_at is null or at - previous_at >= v_cooldown;

  select count(*) into v_count
  from public.campaign_send_log
  where at >= coalesce(v_burst_start, v_last);

  if v_count >= p_batch then
    return jsonb_build_object('allowed', 0, 'wait_until', v_last + v_cooldown);
  end if;
  return jsonb_build_object('allowed', p_batch - v_count, 'wait_until', null);
end;
$$;

-- Contact status: adds the retry_exhausted rule (see the top of 0025).
create or replace function public.contact_delivery_state(p_phone text, p_now timestamptz default now())
returns table (status text, reason text, hold_until timestamptz, review_due_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_reset timestamptz;
  v_last_1026 timestamptz;
  v_last_exhausted timestamptz;
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

  -- The third retry of a 131049 failed too: retries stop and the contact needs a manual review.
  select max(f.failed_at) into v_last_exhausted
  from public.contact_delivery_failures f
  where f.phone_e164 = p_phone and f.error_code = '131049' and f.attempt_number = 3
    and f.failed_at > v_reset and f.failed_at <= p_now;
  if v_last_exhausted is not null then
    return query select 'do_not_send'::text, 'retry_exhausted'::text, null::timestamptz,
                        v_last_exhausted + interval '30 days';
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

-- Failed Messages dashboard data ------------------------------------------------------------------

-- One row per original failed message with where its retries stand.
create or replace view public.failed_message_overview as
select f.id as failure_id, f.campaign_id, c.name as campaign_name, f.recipient_id, f.phone_e164,
       f.wamid, f.error_code, f.error_title, f.failed_at,
       coalesce(a.attempts_made, 0) as attempts_made,
       a.last_attempt_at,
       case
         when r.delivery_status in ('delivered', 'read') or coalesce(a.recovered, false) then 'recovered'
         when coalesce(a.active, false) then 'pending'
         when f.error_code = '131049' and coalesce(a.exhausted, false) then 'exhausted'
         when coalesce(a.stopped, false) then 'stopped'
         when f.error_code = '131049' and coalesce(a.attempts_made, 0) < 3
              and s.status not in ('opt_out', 'do_not_send') then 'eligible'
         else 'not_retryable'
       end as retry_status,
       case when f.error_code = '131049' and coalesce(a.attempts_made, 0) < 3
            then coalesce(a.last_failed_at, f.failed_at)
                 + make_interval(hours => c.retry_delays_hours[coalesce(a.attempts_made, 0) + 1]) end as retry_ready_at,
       s.status as contact_status, s.reason as contact_reason
from public.contact_delivery_failures f
join public.whatsapp_campaigns c on c.id = f.campaign_id
join public.whatsapp_campaign_recipients r on r.id = f.recipient_id
left join lateral (
  select count(*) filter (where m.state in ('accepted', 'rejected', 'uncertain')) as attempts_made,
         max(m.claimed_at) as last_attempt_at,
         bool_or(m.state in ('pending', 'in_flight')
                 or (m.state = 'accepted' and coalesce(m.delivery_status, 'sent') = 'sent')) as active,
         bool_or(m.delivery_status in ('delivered', 'read')) as recovered,
         bool_or(m.attempt_number = 3 and m.delivery_status = 'failed') as exhausted,
         bool_or(m.state in ('rejected', 'uncertain')) as stopped,
         (select max(x.failed_at) from public.contact_delivery_failures x
           where x.recipient_id = f.recipient_id and x.error_code = '131049') as last_failed_at
  from public.campaign_message_retries m where m.recipient_id = f.recipient_id
) a on true
left join lateral public.contact_delivery_state(f.phone_e164) s on true
where f.attempt_number = 0;

create or replace function public.failed_message_summary(p_campaign_id uuid default null)
returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
  with o as (
    select * from public.failed_message_overview
    where p_campaign_id is null or campaign_id = p_campaign_id)
  select jsonb_build_object(
    'total', count(*),
    'eligible', count(*) filter (where retry_status = 'eligible'),
    'eligible_ready', count(*) filter (where retry_status = 'eligible' and retry_ready_at <= now()),
    'pending', count(*) filter (where retry_status = 'pending'),
    'recovered', count(*) filter (where retry_status = 'recovered'),
    'exhausted', count(*) filter (where retry_status = 'exhausted'),
    'stopped', count(*) filter (where retry_status = 'stopped'),
    'not_retryable', count(*) filter (where retry_status = 'not_retryable'),
    'by_code', coalesce((
      select jsonb_agg(jsonb_build_object('code', t.code, 'title', t.title, 'count', t.n) order by t.n desc)
      from (select error_code as code, max(error_title) as title, count(*) as n from o group by 1) t), '[]'::jsonb))
  from o;
$$;

-- "Retry Failed Messages": queue every eligible message whose delay has passed (never immediate).
create or replace function public.retry_failed_messages(p_campaign_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_queued integer := 0;
  v_waiting integer;
begin
  if p_actor_user_id is null then raise exception 'Invalid retry request'; end if;
  for r in
    select recipient_id from public.failed_message_overview
    where retry_status = 'eligible' and retry_ready_at <= now()
      and (p_campaign_id is null or campaign_id = p_campaign_id)
    order by failed_at
  loop
    if public.schedule_campaign_retry(r.recipient_id, 'manual', now(), p_actor_user_id) then
      v_queued := v_queued + 1;
    end if;
  end loop;
  select count(*) into v_waiting from public.failed_message_overview
  where retry_status = 'eligible' and retry_ready_at > now()
    and (p_campaign_id is null or campaign_id = p_campaign_id);
  return jsonb_build_object('queued', v_queued, 'not_ready_yet', v_waiting);
end;
$$;

-- "Enable Auto Retry" for one campaign, with optional delays (hours, strictly increasing).
create or replace function public.set_campaign_auto_retry(
  p_campaign_id uuid, p_enabled boolean, p_delays integer[], p_actor_user_id uuid
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_scheduled integer := 0;
  v_canceled integer := 0;
begin
  if p_campaign_id is null or p_enabled is null or p_actor_user_id is null
     or (p_delays is not null and (cardinality(p_delays) <> 3 or p_delays[1] < 1
         or p_delays[1] >= p_delays[2] or p_delays[2] >= p_delays[3] or p_delays[3] > 720)) then
    raise exception 'Invalid auto retry settings';
  end if;
  update public.whatsapp_campaigns
  set auto_retry = p_enabled, retry_delays_hours = coalesce(p_delays, retry_delays_hours), updated_at = now()
  where id = p_campaign_id;
  if not found then raise exception 'Campaign not found'; end if;

  if p_enabled then
    for r in select recipient_id, retry_ready_at from public.failed_message_overview
             where campaign_id = p_campaign_id and retry_status = 'eligible'
    loop
      if public.schedule_campaign_retry(r.recipient_id, 'auto', coalesce(r.retry_ready_at, now()), p_actor_user_id) then
        v_scheduled := v_scheduled + 1;
      end if;
    end loop;
  else
    update public.campaign_message_retries
    set state = 'canceled', finished_at = now(), updated_at = now()
    where campaign_id = p_campaign_id and trigger = 'auto' and state = 'pending';
    get diagnostics v_canceled = row_count;
  end if;
  return jsonb_build_object('scheduled', v_scheduled, 'canceled', v_canceled);
end;
$$;

revoke all on function public.raise_sender_alert(text, text, text, text) from public, anon, authenticated;
revoke all on function public.resolve_sender_alert(uuid, uuid) from public, anon, authenticated;
revoke all on function public.sender_alert_from_failure() from public, anon, authenticated;
revoke all on function public.schedule_campaign_retry(uuid, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.record_campaign_delivery_failure() from public, anon, authenticated;
revoke all on function public.project_campaign_retry_status() from public, anon, authenticated;
revoke all on function public.claim_campaign_retries(integer) from public, anon, authenticated;
revoke all on function public.campaign_retry_send_gate(uuid) from public, anon, authenticated;
revoke all on function public.record_campaign_retry_result(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.mark_stale_campaign_retries() from public, anon, authenticated;
revoke all on function public.failed_message_summary(uuid) from public, anon, authenticated;
revoke all on function public.retry_failed_messages(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_campaign_auto_retry(uuid, boolean, integer[], uuid) from public, anon, authenticated;
revoke all on public.failed_message_overview, public.campaign_send_log from public, anon, authenticated;
grant execute on function public.raise_sender_alert(text, text, text, text) to service_role;
grant execute on function public.resolve_sender_alert(uuid, uuid) to service_role;
grant execute on function public.schedule_campaign_retry(uuid, text, timestamptz, uuid) to service_role;
grant execute on function public.claim_campaign_retries(integer) to service_role;
grant execute on function public.campaign_retry_send_gate(uuid) to service_role;
grant execute on function public.record_campaign_retry_result(uuid, text, text, text) to service_role;
grant execute on function public.mark_stale_campaign_retries() to service_role;
grant execute on function public.failed_message_summary(uuid) to service_role;
grant execute on function public.retry_failed_messages(uuid, uuid) to service_role;
grant execute on function public.set_campaign_auto_retry(uuid, boolean, integer[], uuid) to service_role;
grant select on public.failed_message_overview, public.campaign_send_log to service_role;
