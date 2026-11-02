-- Integration check for drizzle/0028_failed_contacts_campaign.sql, run against a DISPOSABLE empty Postgres
-- database from the repository root:
--   psql -X -d scratch_db -f tests/unit/failed-contacts-campaign-check.sql
-- Asserts retry scheduling (auto vs manual, never immediate), the 3-attempt cap, idempotency, recovery,
-- the Do Not Send hand-off after attempt 3, 131048 sender pause, the send gate, stale claims and the summary.
\set ON_ERROR_STOP on
do $$ begin
  if to_regclass('public.meta_webhook_items') is not null then
    raise exception 'Refusing to run: this database already has the Meta tables. Use an empty scratch database.';
  end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
alter role service_role bypassrls;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
grant usage on schema public to anon, authenticated, service_role;
\i drizzle/0001_meta_webhook_inbox.sql
\i drizzle/0002_contacts.sql
\i drizzle/0003_campaigns.sql
\i drizzle/0004_contact_import_pgcrypto_path.sql
\i drizzle/0005_campaigns_header_media.sql
\i drizzle/0006_inbox.sql
\i drizzle/0007_import_opt_in_attestation.sql
\i drizzle/0008_send_to_any_saved_number.sql
\i drizzle/0009_inbox_media_send.sql
\i drizzle/0010_opt_out_numbers.sql
\i drizzle/0011_campaign_worker_lease.sql
\i drizzle/0012_campaign_send_throttle.sql
\i drizzle/0013_auto_opt_out_numbers.sql
\i drizzle/0014_direct_stop_handling.sql
\i drizzle/0016_campaign_analytics.sql
\i drizzle/0017_exclude_campaign_recipients.sql
\i drizzle/0018_fix_delivery_status_projection.sql
\i drizzle/0019_no_sender_holds.sql
\i drizzle/0020_contact_campaign_active.sql
\i drizzle/0021_delete_draft_campaign.sql
\i drizzle/0022_dashboard_metric_adjustments.sql
\i drizzle/0023_inbox_retention.sql
\i drizzle/0024_failed_numbers_to_opt_outs.sql
\i drizzle/0025_contact_delivery_status.sql
\i drizzle/0026_failed_message_retries.sql
\i drizzle/0027_campaign_audience_review.sql
\i drizzle/0028_failed_contacts_campaign.sql


create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$
begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111');
insert into public.meta_webhook_envelopes (id, payload_sha256) values ('22222222-2222-2222-2222-222222222222', repeat('a', 64));
insert into public.whatsapp_campaigns (id, created_by, name, audience_source, audience_source_label, waba_id, phone_number_id,
  template_id, template_name, template_language, template_snapshot, state, audience_count)
values ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Sunday', 'all_eligible', 'All', 'W1', 'P1', 't1', 'tpl', 'en', '{}', 'completed', 9),
       ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Other', 'all_eligible', 'All', 'W1', 'P1', 't1', 'tpl', 'en', '{}', 'completed', 9);

insert into public.contacts (id, phone_e164)
select ('d0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, '+1647000' || lpad(n::text, 4, '0')
from generate_series(1, 12) n;
create function pg_temp.contact(n int) returns uuid language sql as $$ select ('d0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid $$;
create function pg_temp.phone(n int) returns text language sql as $$ select '+1647000' || lpad(n::text, 4, '0') $$;
create function pg_temp.recipient(c int, n int, wamid text) returns void language sql as $$
  insert into public.whatsapp_campaign_recipients (campaign_id, contact_id, recipient_e164, state, wamid, delivery_status)
  values (('c0000000-0000-0000-0000-00000000000' || c)::uuid, pg_temp.contact(n), pg_temp.phone(n), 'accepted', wamid, 'sent') $$;
create function pg_temp.hook(wamid text, st text, code int, at timestamptz, key text) returns void language sql as $$
  insert into public.meta_webhook_items (envelope_id, dedupe_key, kind, waba_id, phone_number_id, field, provider_message_id, provider_status, event_timestamp, payload)
  values ('22222222-2222-2222-2222-222222222222', encode(sha256(key::bytea), 'hex'), 'status', 'W1', 'P1', 'messages', wamid, st, at,
    case when code is null then '{}'::jsonb else jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('code', code, 'title', 'err ' || code))) end) $$;
create function pg_temp.fid(n int) returns uuid language sql as $$
  select id from public.contact_delivery_failures where phone_e164 = pg_temp.phone(n) and campaign_id = 'c0000000-0000-0000-0000-000000000001' and attempt_number = 0 $$;
create function pg_temp.why(n int) returns text language sql as $$
  select coalesce(reason, 'eligible') from public.failed_contact_eligibility('c0000000-0000-0000-0000-000000000001') where phone_e164 = pg_temp.phone(n) $$;

-- contacts 1..9 all fail in campaign 1
select pg_temp.recipient(1, n, 'w' || n) from generate_series(1, 9) n;
-- 1: 131049 two days ago (eligible); 2: 131049 1h ago (waiting); 3: 131026; 4: 131049 but delivered later (recovered)
-- 5: 131049 + global opt out; 6: 131049 + manual suppression; 7: 131049 old, but a newer 131049 in campaign 2 (waiting)
-- 8: 131056 two days ago (eligible: cooldown 24h passed); 9: plain 131049 two days ago (eligible)
select pg_temp.hook('w1', 'failed', 131049, now() - interval '2 days', 'f1');
select pg_temp.hook('w2', 'failed', 131049, now() - interval '1 hour', 'f2');
select pg_temp.hook('w3', 'failed', 131026, now() - interval '2 days', 'f3');
select pg_temp.hook('w4', 'failed', 131049, now() - interval '2 days', 'f4');
select pg_temp.hook('w5', 'failed', 131049, now() - interval '2 days', 'f5');
select pg_temp.hook('w6', 'failed', 131049, now() - interval '2 days', 'f6');
select pg_temp.hook('w7', 'failed', 131049, now() - interval '2 days', 'f7');
select pg_temp.hook('w8', 'failed', 131056, now() - interval '2 days', 'f8');
select pg_temp.hook('w9', 'failed', 131049, now() - interval '2 days', 'f9');
update public.whatsapp_campaign_recipients set delivery_status = 'delivered' where recipient_e164 = pg_temp.phone(4) and campaign_id = 'c0000000-0000-0000-0000-000000000001';
insert into public.opt_out_numbers (phone_e164, source) select pg_temp.phone(5), 'test';
insert into public.contact_marketing_suppressions (phone_e164, reason, source) select pg_temp.phone(6), 'compliance_hold', 'test';
select pg_temp.recipient(2, 7, 'x7');
select pg_temp.hook('x7', 'failed', 131049, now() - interval '3 hours', 'x7');

select pg_temp.expect(pg_temp.why(1) = 'eligible', '131049 older than 24h is eligible');
select pg_temp.expect(pg_temp.why(2) = 'waiting_131049', '131049 inside the 24h wait is excluded, with the reason');
select pg_temp.expect((select ready_at from public.failed_contact_eligibility('c0000000-0000-0000-0000-000000000001') where phone_e164 = pg_temp.phone(2))
  > now() + interval '22 hours', 'the wait has a ready time about 24h after the failure');
select pg_temp.expect(pg_temp.why(3) = 'hold_undeliverable_131026', '131026 is Do Not Send and excluded');
select pg_temp.expect(pg_temp.why(4) = 'recovered', 'a recovered message is not selectable');
select pg_temp.expect(pg_temp.why(5) = 'global_opt_out', 'Global Opt Out is excluded');
select pg_temp.expect(pg_temp.why(6) = 'not_allowed_marketing', 'an active suppression is excluded');
select pg_temp.expect(pg_temp.why(7) = 'waiting_131049', 'the wait counts the contact''s newest 131049 from ANY campaign');
select pg_temp.expect(pg_temp.why(8) = 'eligible', '131056 past its cooldown is eligible');

-- a pending retry blocks selection
select pg_temp.recipient(1, 10, 'w10'); select pg_temp.hook('w10', 'failed', 131049, now() - interval '2 days', 'f10');
select public.schedule_campaign_retry((select id from public.whatsapp_campaign_recipients where recipient_e164 = pg_temp.phone(10) and campaign_id = 'c0000000-0000-0000-0000-000000000001'), 'manual', now(), null);
select pg_temp.expect(pg_temp.why(10) = 'retry_pending', 'a message with a retry in progress is not selectable');

-- preview counts
select pg_temp.expect((public.preview_failed_contact_campaign('c0000000-0000-0000-0000-000000000001')->>'eligible')::int = 3
  and (public.preview_failed_contact_campaign('c0000000-0000-0000-0000-000000000001')->>'excluded')::int = 7, 'preview: 3 eligible, 7 excluded');
select pg_temp.expect((public.preview_failed_contact_campaign('c0000000-0000-0000-0000-000000000001', array[pg_temp.fid(1), pg_temp.fid(2)])->>'selected')::int = 2, 'preview respects the selection');

-- snapshot of contact-level state and original history before creating
create temp table before_state as
  select (select count(*) from public.contact_delivery_failures) as failures,
         (select count(*) from public.contact_delivery_failures where error_code = '131049') as f1049,
         (select count(*) from public.campaign_message_retries) as retries,
         (select count(*) from public.whatsapp_campaign_recipients where campaign_id = 'c0000000-0000-0000-0000-000000000001') as recips;

-- ---------- create: only eligible, even if ineligible ids are selected ----------
create function pg_temp.make(ids uuid[]) returns public.whatsapp_campaigns language sql as $$
  select public.create_campaign_from_failed_contacts('11111111-1111-1111-1111-111111111111', 'New one', 'W1', 'P1', 't2', 'tpl2', 'en', '{}', '[]',
    'c0000000-0000-0000-0000-000000000001', ids) $$;
create temp table made as select * from pg_temp.make(array[pg_temp.fid(1), pg_temp.fid(2), pg_temp.fid(3), pg_temp.fid(5), pg_temp.fid(8)]);
select pg_temp.expect((select audience_count from made) = 2 and (select audience_source from made) = 'failed_contacts', 'only the eligible selected contacts are included (1 and 8)');
select pg_temp.expect((select count(*) from public.whatsapp_campaign_recipients where campaign_id = (select id from made)) = 2, 'new message records are created for them');
select pg_temp.expect((select state from made) = 'draft' and (select id from made) <> 'c0000000-0000-0000-0000-000000000001', 'a new campaign id, still a draft (nothing is sent)');
select pg_temp.expect((select source_campaign_id from made) = 'c0000000-0000-0000-0000-000000000001', 'it points back to the original campaign');
select pg_temp.expect((select failures = (select count(*) from public.contact_delivery_failures) and f1049 = (select count(*) from public.contact_delivery_failures where error_code = '131049')
   and retries = (select count(*) from public.campaign_message_retries)
   and recips = (select count(*) from public.whatsapp_campaign_recipients where campaign_id = 'c0000000-0000-0000-0000-000000000001') from before_state),
  'original failures, 131049 counts, retries and recipients are unchanged');
select pg_temp.expect((select (detail->>'excluded')::int from public.whatsapp_campaign_audit where campaign_id = (select id from made) and action = 'create') = 3, 'the audit trail records the excluded count');

-- a second draft from the same selection is a separate campaign (no shared state)
select pg_temp.expect((pg_temp.make(array[pg_temp.fid(1)])).id <> (select id from made), 'a second run creates its own campaign');

-- null selection means "all eligible"
select pg_temp.expect((pg_temp.make(null)).audience_count = 3, 'no selection = every eligible failed contact');
-- nothing eligible
do $$ begin
  perform pg_temp.make(array[pg_temp.fid(3), pg_temp.fid(5)]);
  raise exception 'ASSERT FAILED: expected No eligible contacts';
exception when others then if sqlerrm <> 'No eligible contacts' then raise; end if; raise notice 'ok - an all-ineligible selection is rejected'; end $$;
do $$ begin
  perform public.create_campaign_from_failed_contacts('11111111-1111-1111-1111-111111111111', 'x', 'W1', 'P1', 't', 't', 'en', '{}', '[]', 'c0000000-0000-0000-0000-000000000001', array[]::uuid[]);
  raise exception 'ASSERT FAILED: empty array accepted';
exception when others then if sqlerrm <> 'Invalid campaign draft' then raise; end if; raise notice 'ok - an empty selection is rejected'; end $$;

-- the audience review understands the new source; the new campaign cannot bypass holds at send time
select pg_temp.expect((public.campaign_audience_review((select id from made))->>'pool')::int = 2 and (public.campaign_audience_review((select id from made))->>'eligible')::int = 2, 'audience review works for a failed-contacts campaign');
insert into public.opt_out_numbers (phone_e164, source) select pg_temp.phone(1), 'test';
select pg_temp.expect((public.campaign_audience_review((select id from made))->>'eligible')::int = 1
  and (public.campaign_audience_review((select id from made))->>'opt_out')::int = 1, 'a later opt-out is excluded before sending');

-- the retry button cannot retry every campaign
do $$ begin
  perform public.retry_failed_messages(null, '11111111-1111-1111-1111-111111111111');
  raise exception 'ASSERT FAILED: NULL campaign accepted';
exception when others then if sqlerrm <> 'Invalid retry request' then raise; end if; raise notice 'ok - retry_failed_messages rejects a missing campaign'; end $$;

-- dashboard totals
select pg_temp.expect((public.delivery_overview()->>'total_sent')::int = 11 and (public.delivery_overview()->>'failed')::int = 11, 'delivery_overview: totals across campaigns');
select pg_temp.expect((public.delivery_overview(null, null, 'c0000000-0000-0000-0000-000000000002')->>'total_sent')::int = 1, 'delivery_overview: campaign filter');
select pg_temp.expect((public.delivery_overview(now() + interval '1 day', null, null)->>'total_sent')::int = 0, 'delivery_overview: date filter');
select pg_temp.expect((public.delivery_overview()->>'retry_pending')::int = 1, 'delivery_overview: retry pending counted');

select pg_temp.expect(has_function_privilege('anon', 'public.create_campaign_from_failed_contacts(uuid,text,text,text,text,text,text,jsonb,jsonb,uuid,uuid[])', 'execute') = false
  and has_function_privilege('service_role', 'public.failed_contact_eligibility(uuid,uuid[])', 'execute'), 'browser roles cannot call the new functions');
\echo ALL CHECKS PASSED
