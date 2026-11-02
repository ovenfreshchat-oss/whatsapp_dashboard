-- Failed messages live inside each campaign, and eligible failed contacts can seed a NEW campaign.
-- Safe to rerun. Never deletes or edits a failure, a retry or a contact. Needs 0025, 0026 and 0027.
--
--   1. whatsapp_campaigns: audience_source may be 'failed_contacts'; source_campaign_id points back.
--   2. failed_contact_eligibility(): the stricter gate for "Create New Campaign with Selected Contacts".
--      It adds what can_send_whatsapp_marketing does not check: recovered, retry in progress, and the
--      24h wait after a 131049. Global opt-out, suppression and Do Not Send are checked as before.
--   3. preview_failed_contact_campaign(): eligible / excluded counts by reason, before launch.
--   4. create_campaign_from_failed_contacts(): makes a new draft. It reads the original failures
--      and never changes them, so contact-level 131049 counts are untouched.
--   5. delivery_overview(): dashboard totals across campaigns, with date and campaign filters.
--   6. campaign_audience_review(): understands the new audience source.
--   7. retry_failed_messages(): a campaign is now required, so nothing can retry "all campaigns".

alter table public.whatsapp_campaigns
  add column if not exists source_campaign_id uuid references public.whatsapp_campaigns(id);

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.whatsapp_campaigns'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%audience_source%'
  loop
    execute format('alter table public.whatsapp_campaigns drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.whatsapp_campaigns
  add constraint whatsapp_campaigns_audience_source_check
    check (audience_source in ('import_batch', 'all_eligible', 'failed_contacts')),
  add constraint whatsapp_campaigns_audience_shape_check
    check ((audience_source = 'import_batch' and import_batch_id is not null and source_campaign_id is null)
        or (audience_source = 'all_eligible' and import_batch_id is null and source_campaign_id is null)
        or (audience_source = 'failed_contacts' and import_batch_id is null and source_campaign_id is not null));

-- Eligibility of the failed contacts of one campaign (all of them, or only the listed failure ids).
-- reason is a code the page turns into words. ready_at is set when the only blocker is a waiting time.
create or replace function public.failed_contact_eligibility(p_campaign_id uuid, p_failure_ids uuid[] default null)
returns table (failure_id uuid, recipient_id uuid, contact_id uuid, phone_e164 text, error_code text,
               eligible boolean, reason text, ready_at timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  c public.whatsapp_campaigns;
begin
  select * into c from public.whatsapp_campaigns where id = p_campaign_id;
  if not found then raise exception 'Campaign not found'; end if;

  return query
  with base as (
    select f.id as fid, f.recipient_id as rid, f.phone_e164 as phone, f.error_code as code, f.failed_at,
           ct.id as cid, r.delivery_status as original_status,
           (select max(x.failed_at) from public.contact_delivery_failures x
             where x.phone_e164 = f.phone_e164 and x.error_code = '131049') as last_1049,
           exists (select 1 from public.campaign_message_retries m
                   where m.recipient_id = f.recipient_id and m.delivery_status in ('delivered', 'read')) as recovered_by_retry,
           exists (select 1 from public.campaign_message_retries m
                   where m.recipient_id = f.recipient_id
                     and (m.state in ('pending', 'in_flight')
                          or (m.state = 'accepted' and coalesce(m.delivery_status, 'sent') = 'sent'))) as retry_active
    from public.contact_delivery_failures f
    join public.whatsapp_campaign_recipients r on r.id = f.recipient_id
    left join public.contacts ct on ct.phone_e164 = f.phone_e164
    where f.campaign_id = p_campaign_id and f.attempt_number = 0
      and (p_failure_ids is null or f.id = any (p_failure_ids))
  ), judged as (
    select b.*, s.status as contact_status, s.reason as contact_reason,
           case when b.cid is null then false
                else public.can_send_whatsapp_marketing(b.cid, c.waba_id, c.phone_number_id) end as sendable
    from base b
    cross join lateral public.contact_delivery_state(b.phone) s
  )
  select j.fid, j.rid, j.cid, j.phone, j.code,
         (j.reason_code is null), j.reason_code,
         case when j.reason_code = 'waiting_131049' then j.last_1049 + interval '24 hours' end
  from (
    select jd.*, case
      when jd.original_status in ('delivered', 'read') or jd.recovered_by_retry then 'recovered'
      when jd.retry_active then 'retry_pending'
      when jd.cid is null then 'not_a_saved_contact'
      when jd.contact_status = 'opt_out' then 'global_opt_out'
      when jd.contact_status = 'do_not_send' then 'hold_' || coalesce(jd.contact_reason, 'manual_review')
      when not jd.sendable then 'not_allowed_marketing'
      when jd.code in ('131026') then 'undeliverable_131026'
      when jd.code in ('131050') then 'opted_out_131050'
      when jd.code = '131049' and jd.last_1049 is not null
           and now() < jd.last_1049 + interval '24 hours' then 'waiting_131049'
      else null end as reason_code
    from judged jd
  ) j
  order by j.failed_at;
end;
$$;

-- Counts for the review step: how many can go, how many are left out, and why.
create or replace function public.preview_failed_contact_campaign(p_campaign_id uuid, p_failure_ids uuid[] default null)
returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
  with e as (select * from public.failed_contact_eligibility(p_campaign_id, p_failure_ids))
  select jsonb_build_object(
    'selected', (select count(*) from e),
    'eligible', (select count(*) from e where eligible),
    'excluded', (select count(*) from e where not eligible),
    'reasons', coalesce((select jsonb_object_agg(reason, n) from (
        select reason, count(*) as n from e where not eligible group by reason) g), '{}'::jsonb),
    'ready_at', (select min(ready_at) from e where reason = 'waiting_131049'));
$$;

create or replace function public.create_campaign_from_failed_contacts(
  p_created_by uuid, p_name text, p_waba_id text, p_phone_number_id text, p_template_id text,
  p_template_name text, p_template_language text, p_template_snapshot jsonb, p_body_parameters jsonb,
  p_source_campaign_id uuid, p_failure_ids uuid[]
) returns public.whatsapp_campaigns language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  campaign public.whatsapp_campaigns;
  source public.whatsapp_campaigns;
  v_eligible integer;
  v_excluded integer;
  v_label text;
begin
  if p_created_by is null or length(trim(coalesce(p_name, ''))) not between 1 and 120
     or nullif(p_waba_id, '') is null or nullif(p_phone_number_id, '') is null
     or nullif(p_template_id, '') is null or nullif(p_template_name, '') is null
     or nullif(p_template_language, '') is null
     or jsonb_typeof(p_template_snapshot) <> 'object' or jsonb_typeof(p_body_parameters) <> 'array'
     or p_source_campaign_id is null
     or (p_failure_ids is not null and coalesce(cardinality(p_failure_ids), 0) = 0) then
    raise exception 'Invalid campaign draft';
  end if;
  select * into source from public.whatsapp_campaigns where id = p_source_campaign_id;
  if not found then raise exception 'Campaign not found'; end if;

  select count(distinct e.contact_id) filter (where e.eligible), count(*) filter (where not e.eligible)
  into v_eligible, v_excluded
  from public.failed_contact_eligibility(p_source_campaign_id, p_failure_ids) e;
  if coalesce(v_eligible, 0) = 0 then raise exception 'No eligible contacts'; end if;

  v_label := left('Failed contacts from ' || source.name, 255);
  insert into public.whatsapp_campaigns (
    created_by, name, audience_source, import_batch_id, source_campaign_id, audience_source_label,
    waba_id, phone_number_id, template_id, template_name, template_language, template_snapshot, body_parameters
  ) values (
    p_created_by, trim(p_name), 'failed_contacts', null, p_source_campaign_id, v_label,
    p_waba_id, p_phone_number_id, p_template_id, p_template_name, p_template_language,
    p_template_snapshot, p_body_parameters
  ) returning * into campaign;

  insert into public.whatsapp_campaign_recipients (campaign_id, contact_id, consent_event_id, recipient_e164)
  select distinct on (e.contact_id) campaign.id, e.contact_id, null, e.phone_e164
  from public.failed_contact_eligibility(p_source_campaign_id, p_failure_ids) e
  where e.eligible and e.contact_id is not null
  order by e.contact_id;

  update public.whatsapp_campaigns
  set audience_count = v_eligible, updated_at = now()
  where id = campaign.id returning * into campaign;
  insert into public.whatsapp_campaign_audit (campaign_id, actor_user_id, action, detail)
  values (campaign.id, p_created_by, 'create', jsonb_build_object(
    'audience_count', v_eligible, 'audience_source', 'failed_contacts',
    'source_campaign_id', p_source_campaign_id, 'excluded', v_excluded,
    'audience_source_label', v_label));
  return campaign;
end;
$$;

-- Dashboard totals. Sent = accepted by Meta. Delivered counts delivered and read. Failed is the number of
-- original failures (they stay in history even when a retry later recovers the message).
create or replace function public.delivery_overview(
  p_from timestamptz default null, p_to timestamptz default null, p_campaign_id uuid default null
) returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
  with sent as (
    select count(*) filter (where r.state = 'accepted') as total_sent,
           count(*) filter (where r.state = 'accepted' and r.delivery_status in ('delivered', 'read')) as delivered
    from public.whatsapp_campaign_recipients r
    where (p_campaign_id is null or r.campaign_id = p_campaign_id)
      and (p_from is null or coalesce(r.finished_at, r.created_at) >= p_from)
      and (p_to is null or coalesce(r.finished_at, r.created_at) < p_to)
  ), failed as (
    select count(*) as failed,
           count(*) filter (where o.retry_status = 'pending') as retry_pending,
           count(*) filter (where o.retry_status = 'recovered') as recovered,
           count(*) filter (where o.retry_status = 'exhausted') as exhausted
    from public.failed_message_overview o
    where (p_campaign_id is null or o.campaign_id = p_campaign_id)
      and (p_from is null or o.failed_at >= p_from)
      and (p_to is null or o.failed_at < p_to)
  )
  select jsonb_build_object(
    'total_sent', sent.total_sent, 'delivered', sent.delivered, 'failed', failed.failed,
    'delivery_rate', case when sent.total_sent > 0 then round(sent.delivered * 100.0 / sent.total_sent, 1) else 0 end,
    'retry_pending', failed.retry_pending, 'recovered', failed.recovered, 'retry_exhausted', failed.exhausted)
  from sent, failed;
$$;

-- campaign_audience_review (0027) with the new audience source: the pool is the contacts already
-- captured for the campaign.
create or replace function public.campaign_audience_review(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  c public.whatsapp_campaigns;
  v_result jsonb;
begin
  select * into c from public.whatsapp_campaigns where id = p_campaign_id;
  if not found then raise exception 'Campaign not found'; end if;

  with pool as (
    select ct.id, ct.phone_e164
    from public.contacts ct
    where ct.phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
      and (c.audience_source = 'all_eligible'
           or (c.audience_source = 'failed_contacts'
               and exists (select 1 from public.whatsapp_campaign_recipients r
                           where r.campaign_id = c.id and r.contact_id = ct.id))
           or exists (select 1 from public.contact_batch_members m
                      where m.batch_id = c.import_batch_id and m.contact_id = ct.id))
  ), judged as (
    select p.id, s.status,
           public.can_send_whatsapp_marketing(p.id, c.waba_id, c.phone_number_id) as sendable,
           exists (select 1 from public.whatsapp_campaign_recipients r
                   where r.campaign_id = c.id and r.contact_id = p.id) as in_campaign,
           exists (select 1 from public.whatsapp_campaign_recipients r
                   where r.campaign_id = c.id and r.contact_id = p.id and r.state = 'pending') as pending_send
    from pool p
    cross join lateral public.contact_delivery_state(p.phone_e164) s
  )
  select jsonb_build_object(
    'pool', count(*),
    'eligible', count(*) filter (where sendable),
    'excluded', count(*) filter (where not sendable),
    'opt_out', count(*) filter (where not sendable and status = 'opt_out'),
    'do_not_send', count(*) filter (where not sendable and status = 'do_not_send'),
    'other', count(*) filter (where not sendable and status not in ('opt_out', 'do_not_send')),
    'at_risk_eligible', count(*) filter (where sendable and status = 'at_risk'),
    'in_campaign', count(*) filter (where in_campaign),
    'will_skip_at_send', count(*) filter (where pending_send and not sendable))
  into v_result from judged;
  return v_result;
end;
$$;

-- "Retry Failed Messages" always belongs to one campaign. NULL used to mean every campaign.
create or replace function public.retry_failed_messages(p_campaign_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_queued integer := 0;
  v_waiting integer;
begin
  if p_actor_user_id is null or p_campaign_id is null then raise exception 'Invalid retry request'; end if;
  for r in
    select recipient_id from public.failed_message_overview
    where retry_status = 'eligible' and retry_ready_at <= now() and campaign_id = p_campaign_id
    order by failed_at
  loop
    if public.schedule_campaign_retry(r.recipient_id, 'manual', now(), p_actor_user_id) then
      v_queued := v_queued + 1;
    end if;
  end loop;
  select count(*) into v_waiting from public.failed_message_overview
  where retry_status = 'eligible' and retry_ready_at > now() and campaign_id = p_campaign_id;
  return jsonb_build_object('queued', v_queued, 'not_ready_yet', v_waiting);
end;
$$;

revoke all on function public.failed_contact_eligibility(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.preview_failed_contact_campaign(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.create_campaign_from_failed_contacts(uuid, text, text, text, text, text, text, jsonb, jsonb, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.delivery_overview(timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.campaign_audience_review(uuid) from public, anon, authenticated;
revoke all on function public.retry_failed_messages(uuid, uuid) from public, anon, authenticated;
grant execute on function public.failed_contact_eligibility(uuid, uuid[]) to service_role;
grant execute on function public.preview_failed_contact_campaign(uuid, uuid[]) to service_role;
grant execute on function public.create_campaign_from_failed_contacts(uuid, text, text, text, text, text, text, jsonb, jsonb, uuid, uuid[]) to service_role;
grant execute on function public.delivery_overview(timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.campaign_audience_review(uuid) to service_role;
grant execute on function public.retry_failed_messages(uuid, uuid) to service_role;
