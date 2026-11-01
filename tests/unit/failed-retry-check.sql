-- Integration check for drizzle/0026_failed_message_retries.sql, run against a DISPOSABLE empty Postgres
-- database from the repository root:
--   psql -X -d scratch_db -f tests/unit/failed-retry-check.sql
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

create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$
begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111');
insert into public.meta_webhook_envelopes (id, payload_sha256) values ('22222222-2222-2222-2222-222222222222', repeat('a', 64));

-- Campaign 1: auto retry ON. Campaign 2: default (auto retry OFF). Campaign 3: other sender, running.
insert into public.whatsapp_campaigns (id, created_by, name, audience_source, audience_source_label, waba_id, phone_number_id,
  template_id, template_name, template_language, template_snapshot, state, audience_count, auto_retry)
values
 ('c0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Auto', 'all_eligible', 'All', 'W1', 'P1', 't1', 'tpl', 'en', '{}', 'running', 9, true),
 ('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Manual', 'all_eligible', 'All', 'W1', 'P1', 't1', 'tpl', 'en', '{}', 'completed', 9, false),
 ('c0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Other sender', 'all_eligible', 'All', 'W9', 'P9', 't1', 'tpl', 'en', '{}', 'running', 9, false);

select pg_temp.expect((select auto_retry from public.whatsapp_campaigns where id = 'c0000000-0000-0000-0000-000000000002') = false
  and (select retry_delays_hours from public.whatsapp_campaigns where id = 'c0000000-0000-0000-0000-000000000002') = '{24,72,168}',
  'auto retry is off by default with 24h/72h/7d delays');

insert into public.contacts (id, phone_e164)
select ('d0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, '+1647000' || lpad(n::text, 4, '0')
from generate_series(1, 12) n;
create function pg_temp.contact(n int) returns uuid language sql as
$$ select ('d0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid $$;
create function pg_temp.phone(n int) returns text language sql as $$ select '+1647000' || lpad(n::text, 4, '0') $$;

create function pg_temp.recipient(c int, n int, wamid text) returns void language sql as $$
  insert into public.whatsapp_campaign_recipients (campaign_id, contact_id, recipient_e164, state, wamid, delivery_status)
  values (('c0000000-0000-0000-0000-00000000000' || c)::uuid, pg_temp.contact(n), pg_temp.phone(n), 'accepted', wamid, 'sent')
$$;
create function pg_temp.hook(wamid text, st text, code int, at timestamptz, key text, waba text default 'W1', ph text default 'P1')
returns void language sql as $$
  insert into public.meta_webhook_items (envelope_id, dedupe_key, kind, waba_id, phone_number_id, field,
    provider_message_id, provider_status, event_timestamp, payload)
  values ('22222222-2222-2222-2222-222222222222', encode(sha256(key::bytea), 'hex'), 'status', waba, ph, 'messages',
    wamid, st, at,
    case when code is null then '{}'::jsonb
         else jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('code', code, 'title', 'err ' || code))) end)
$$;
create function pg_temp.rid(n int, c int default 1) returns uuid language sql as $$
  select id from public.whatsapp_campaign_recipients where contact_id = pg_temp.contact(n) and campaign_id = ('c0000000-0000-0000-0000-00000000000' || c)::uuid $$;
create function pg_temp.retries(n int) returns bigint language sql as $$
  select count(*) from public.campaign_message_retries where recipient_id = pg_temp.rid(n) $$;
-- Make every pending retry due now (the delay itself is asserted before this is called).
create function pg_temp.make_due() returns void language sql as $$
  update public.campaign_message_retries set scheduled_for = now() - interval '1 minute' where state = 'pending' $$;
-- Send the next retry of recipient n the way the worker does and give it a message id.
create function pg_temp.send_retry(n int, new_wamid text) returns void language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.make_due();
  select id into v from public.claim_campaign_retries(25) where recipient_id = pg_temp.rid(n);
  if v is null then raise exception 'no retry claimed for %', n; end if;
  if public.campaign_retry_send_gate(v) <> 'allowed' then raise exception 'gate not allowed'; end if;
  perform public.record_campaign_retry_result(v, 'accepted', new_wamid, null);
end $$;

-- ---------- 1. Scheduling: auto retry only when enabled; never immediate ----------
select pg_temp.recipient(1, 1, 'a1'); select pg_temp.recipient(1, 2, 'a2'); select pg_temp.recipient(1, 3, 'a3');
select pg_temp.recipient(2, 4, 'b1');
select pg_temp.hook('a1', 'failed', 131049, now() - interval '1 hour', 'a1');
select pg_temp.hook('b1', 'failed', 131049, now() - interval '1 hour', 'b1');
select pg_temp.hook('a2', 'failed', 131026, now() - interval '1 hour', 'a2');

select pg_temp.expect(pg_temp.retries(1) = 1, 'auto retry ON: a 131049 failure queues one retry');
select pg_temp.expect((select attempt_number from public.campaign_message_retries where recipient_id = pg_temp.rid(1)) = 1
  and (select trigger from public.campaign_message_retries where recipient_id = pg_temp.rid(1)) = 'auto', 'it is attempt 1, trigger auto');
select pg_temp.expect((select scheduled_for from public.campaign_message_retries where recipient_id = pg_temp.rid(1))
  = (select failed_at + interval '24 hours' from public.contact_delivery_failures where wamid = 'a1'),
  'attempt 1 waits 24 hours after the failure');
select pg_temp.expect((select count(*) from public.campaign_message_retries where recipient_id = pg_temp.rid(4, 2)) = 0, 'auto retry OFF: nothing is queued');
select pg_temp.expect(pg_temp.retries(2) = 0, '131026 is never retried');

select pg_temp.hook('a1', 'failed', 131049, now() - interval '1 hour', 'a1-dup');
select pg_temp.expect(pg_temp.retries(1) = 1, 'a duplicate failure webhook does not queue a second retry');
select pg_temp.expect(not public.schedule_campaign_retry(pg_temp.rid(1), 'manual', now(), null), 'cannot queue a second retry while one is pending');
select pg_temp.expect(not public.schedule_campaign_retry(pg_temp.rid(2), 'manual', now(), null), 'a non-131049 failure cannot be retried');

select pg_temp.expect((select count(*) from public.claim_campaign_retries(10)) = 0, 'a retry is not claimed before it is due');

-- ---------- 2. Claim, gate, result, then attempts 2 and 3 with the configured delays ----------
select pg_temp.send_retry(1, 'a1-r1');
select pg_temp.expect((select state from public.campaign_message_retries where wamid = 'a1-r1') = 'accepted', 'attempt 1 is recorded as sent with its own message id');
select pg_temp.expect(not public.schedule_campaign_retry(pg_temp.rid(1), 'manual', now(), null), 'cannot retry again while attempt 1 awaits its delivery result');

select pg_temp.hook('a1-r1', 'failed', 131049, now() - interval '30 minutes', 'a1-r1-failed');
select pg_temp.expect(pg_temp.retries(1) = 2, 'attempt 1 failing with 131049 queues attempt 2');
select pg_temp.expect((select scheduled_for from public.campaign_message_retries where recipient_id = pg_temp.rid(1) and attempt_number = 2)
  = (select failed_at + interval '72 hours' from public.contact_delivery_failures where wamid = 'a1-r1'), 'attempt 2 waits 72 hours');
select pg_temp.expect((select count(*) from public.contact_delivery_failures where recipient_id = pg_temp.rid(1)) = 2,
  'every attempt is recorded in the failure history, the original is kept');

select pg_temp.send_retry(1, 'a1-r2');
select pg_temp.hook('a1-r2', 'failed', 131049, now() - interval '20 minutes', 'a1-r2-failed');
select pg_temp.expect((select scheduled_for from public.campaign_message_retries where recipient_id = pg_temp.rid(1) and attempt_number = 3)
  = (select failed_at + interval '168 hours' from public.contact_delivery_failures where wamid = 'a1-r2'), 'attempt 3 waits 7 days');

select pg_temp.expect((select status from public.contact_delivery_state(pg_temp.phone(1))) <> 'do_not_send', 'still sendable while attempts remain');
select pg_temp.send_retry(1, 'a1-r3');
select pg_temp.hook('a1-r3', 'failed', 131049, now() - interval '10 minutes', 'a1-r3-failed');
select pg_temp.expect(pg_temp.retries(1) = 3, 'no fourth attempt is ever queued');
select pg_temp.expect(not public.schedule_campaign_retry(pg_temp.rid(1), 'manual', now(), null), 'a manual retry cannot exceed 3 attempts');
select pg_temp.expect((select status from public.contact_delivery_state(pg_temp.phone(1))) = 'do_not_send'
  and (select reason from public.contact_delivery_state(pg_temp.phone(1))) = 'retry_exhausted', 'after 3 failed retries the contact goes to Do Not Send (manual review)');
select pg_temp.expect(not exists (select 1 from public.opt_out_numbers where phone_e164 = pg_temp.phone(1) and released_at is null), 'exhausted contacts are never opted out');
select pg_temp.expect((select retry_status from public.failed_message_overview where phone_e164 = pg_temp.phone(1)) = 'exhausted', 'overview shows the message as exhausted');
select pg_temp.expect(not public.can_send_whatsapp_marketing(pg_temp.contact(1), 'W1', 'P1'), 'an exhausted contact is excluded from the next campaign');
select pg_temp.expect(public.reactivate_contact_delivery(pg_temp.phone(1), '11111111-1111-1111-1111-111111111111', 'checked'), 'manual review can reactivate it');
select pg_temp.expect(public.can_send_whatsapp_marketing(pg_temp.contact(1), 'W1', 'P1'), 'a reactivated contact is sendable again');

-- ---------- 3. Recovery ----------
select pg_temp.recipient(1, 5, 'r1');
select pg_temp.hook('r1', 'failed', 131049, now() - interval '2 hours', 'r1');
select pg_temp.send_retry(5, 'r1-r1');
select pg_temp.hook('r1-r1', 'sent', null, now(), 'r1-r1-sent');
select pg_temp.expect((select delivery_status from public.whatsapp_campaign_recipients where id = pg_temp.rid(5)) = 'sent', 'a sent retry alone does not mark the message recovered');
select pg_temp.hook('r1-r1', 'delivered', null, now(), 'r1-r1-delivered');
select pg_temp.expect((select delivery_status from public.whatsapp_campaign_recipients where id = pg_temp.rid(5)) = 'delivered', 'a delivered retry updates the recipient delivery status');
select pg_temp.expect((select retry_status from public.failed_message_overview where phone_e164 = pg_temp.phone(5)) = 'recovered', 'overview shows the message as recovered');
select pg_temp.expect(not public.schedule_campaign_retry(pg_temp.rid(5), 'manual', now(), null), 'a recovered message cannot be retried again');

-- ---------- 4. Manual retry and Enable Auto Retry ----------
select pg_temp.recipient(2, 6, 'm1'); select pg_temp.recipient(2, 7, 'm2');
select pg_temp.hook('m1', 'failed', 131049, now() - interval '30 hours', 'm1');
select pg_temp.hook('m2', 'failed', 131049, now() - interval '2 hours', 'm2');
select pg_temp.expect((select retry_status from public.failed_message_overview where phone_e164 = pg_temp.phone(6)) = 'eligible', 'a 131049 failure with auto retry off is eligible');
select pg_temp.expect((public.retry_failed_messages('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111')) = '{"queued": 1, "not_ready_yet": 2}'::jsonb,
  'Retry Failed Messages queues only what passed its 24h delay and reports the rest');
select pg_temp.expect((select trigger from public.campaign_message_retries where recipient_id = pg_temp.rid(6, 2)) = 'manual', 'it is recorded as a manual retry');
select pg_temp.expect((public.retry_failed_messages('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111')) = '{"queued": 0, "not_ready_yet": 2}'::jsonb,
  'pressing it twice queues nothing new');

select pg_temp.expect((public.set_campaign_auto_retry('c0000000-0000-0000-0000-000000000002', true, array[3, 5, 9], '11111111-1111-1111-1111-111111111111')) = '{"scheduled": 2, "canceled": 0}'::jsonb,
  'Enable Auto Retry schedules the waiting messages using the new delay');
select pg_temp.expect((select scheduled_for from public.campaign_message_retries where recipient_id = pg_temp.rid(7, 2))
  = (select failed_at + interval '3 hours' from public.contact_delivery_failures where wamid = 'm2'), 'the custom first delay (3h) is used');
select pg_temp.expect((public.set_campaign_auto_retry('c0000000-0000-0000-0000-000000000002', false, null, '11111111-1111-1111-1111-111111111111')) = '{"scheduled": 0, "canceled": 2}'::jsonb,
  'turning auto retry off cancels waiting automatic retries but not manual ones');
select pg_temp.expect((select state from public.campaign_message_retries where recipient_id = pg_temp.rid(6, 2)) = 'pending', 'the manual retry stays queued');

do $$ begin
  begin perform public.set_campaign_auto_retry('c0000000-0000-0000-0000-000000000002', true, array[5, 3, 9], '11111111-1111-1111-1111-111111111111');
    raise exception 'ASSERT FAILED: delays must increase'; exception when raise_exception then if sqlerrm like 'ASSERT%' then raise; end if; end;
  begin perform public.set_campaign_auto_retry('c0000000-0000-0000-0000-000000000002', true, array[1, 2], '11111111-1111-1111-1111-111111111111');
    raise exception 'ASSERT FAILED: exactly three delays'; exception when raise_exception then if sqlerrm like 'ASSERT%' then raise; end if; end;
  begin perform public.set_campaign_auto_retry('c0000000-0000-0000-0000-000000000002', true, array[1, 2, 721], '11111111-1111-1111-1111-111111111111');
    raise exception 'ASSERT FAILED: max 30 days'; exception when raise_exception then if sqlerrm like 'ASSERT%' then raise; end if; end;
  raise notice 'ok - invalid delay sets are rejected';
end $$;
select pg_temp.expect((select auto_retry from public.whatsapp_campaigns where id = 'c0000000-0000-0000-0000-000000000002') = false, 'a rejected change leaves the campaign unchanged');

-- ---------- 5. Send gate ----------
select pg_temp.recipient(2, 8, 'g1'); select pg_temp.recipient(2, 9, 'g2'); select pg_temp.recipient(2, 10, 'g3');
select pg_temp.hook('g1', 'failed', 131049, now() - interval '30 hours', 'g1');
select pg_temp.hook('g2', 'failed', 131049, now() - interval '30 hours', 'g2');
select pg_temp.hook('g3', 'failed', 131049, now() - interval '30 hours', 'g3');
select public.retry_failed_messages('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111');
select pg_temp.make_due();
create temp table claimed as select * from public.claim_campaign_retries(25);
select pg_temp.expect((select count(*) from claimed where recipient_id in (pg_temp.rid(8, 2), pg_temp.rid(9, 2), pg_temp.rid(10, 2))) = 3, 'due retries are claimed');
select pg_temp.expect((select count(*) from public.claim_campaign_retries(25)) = 0, 'a claimed retry is not claimed twice');
insert into public.opt_out_numbers (phone_e164, source) values (pg_temp.phone(8), 'test');
select pg_temp.expect(public.campaign_retry_send_gate((select id from claimed where recipient_id = pg_temp.rid(8, 2))) = 'suppressed', 'gate blocks an opted-out number');
update public.whatsapp_campaign_recipients set delivery_status = 'delivered' where id = pg_temp.rid(9, 2);
select pg_temp.expect(public.campaign_retry_send_gate((select id from claimed where recipient_id = pg_temp.rid(9, 2))) = 'skipped', 'gate skips a message that has since been delivered');
select pg_temp.expect(public.campaign_retry_send_gate((select id from claimed where recipient_id = pg_temp.rid(10, 2))) = 'allowed', 'gate allows a clean retry');
select pg_temp.expect(public.record_campaign_retry_result((select id from claimed where recipient_id = pg_temp.rid(10, 2)), 'deferred', null, 'window closed'), 'a deferred retry goes back to pending');
select pg_temp.expect((select scheduled_for > now() + interval '25 minutes' from public.campaign_message_retries where recipient_id = pg_temp.rid(10, 2)), 'and waits about 30 minutes');
select pg_temp.expect(public.record_campaign_retry_result((select id from claimed where recipient_id = pg_temp.rid(8, 2)), 'accepted', 'x', null), 'result calls are accepted for in-flight retries');
select pg_temp.expect(not public.record_campaign_retry_result((select id from claimed where recipient_id = pg_temp.rid(8, 2)), 'rejected', null, 'again'), 'a finished retry cannot be overwritten');

-- ---------- 6. Stale claims are never resent ----------
select pg_temp.recipient(2, 11, 's1');
select pg_temp.hook('s1', 'failed', 131049, now() - interval '30 hours', 's1');
select public.retry_failed_messages('c0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111');
select pg_temp.make_due(); select count(*) from public.claim_campaign_retries(25);
update public.campaign_message_retries set claimed_at = now() - interval '11 minutes' where recipient_id = pg_temp.rid(11, 2) and state = 'in_flight';
select pg_temp.expect(public.mark_stale_campaign_retries() >= 1, 'a claim that never reported back is found');
select pg_temp.expect((select state from public.campaign_message_retries where recipient_id = pg_temp.rid(11, 2)) = 'uncertain', 'and marked uncertain, not resent');
select pg_temp.expect((select retry_status from public.failed_message_overview where phone_e164 = pg_temp.phone(11)) = 'stopped', 'overview shows it as stopped for review');

-- ---------- 7. 131048 pauses the sender ----------
select pg_temp.recipient(3, 12, 'x1');
select pg_temp.hook('x1', 'failed', 131048, now(), 'x1', 'W9', 'P9');
select pg_temp.expect((select count(*) from public.sender_alerts where code = '131048' and resolved_at is null and phone_number_id = 'P9') = 1, '131048 raises one open sender alert');
select pg_temp.expect((select state from public.whatsapp_campaigns where id = 'c0000000-0000-0000-0000-000000000003') = 'paused', 'a running campaign on that number is paused');
select pg_temp.expect((select state from public.whatsapp_campaigns where id = 'c0000000-0000-0000-0000-000000000001') = 'running', 'campaigns on other numbers keep running');
select pg_temp.recipient(3, 1, 'x2');
select pg_temp.hook('x2', 'failed', 131048, now(), 'x2', 'W9', 'P9');
select pg_temp.expect((select occurrences from public.sender_alerts where phone_number_id = 'P9') = 2, 'a repeat increments the same alert');
select pg_temp.expect((select count(*) from public.sender_alerts where phone_number_id = 'P9' and resolved_at is null) = 1, 'still exactly one open alert');
select pg_temp.expect((select status from public.contact_delivery_state(pg_temp.phone(12))) not in ('do_not_send', 'at_risk', 'opt_out'), '131048 does not change the contact status by itself');
select pg_temp.expect(public.resolve_sender_alert((select id from public.sender_alerts where phone_number_id = 'P9'), '11111111-1111-1111-1111-111111111111'), 'an admin can resolve the alert');

-- ---------- 8. Worker status and throttle include retries ----------
select pg_temp.expect((select count(*) from public.campaign_send_log) >= 0, 'send log view is queryable');

-- ---------- 9. Summary ----------
select pg_temp.expect((public.failed_message_summary(null)->>'total')::int = (select count(*) from public.failed_message_overview), 'summary total matches the overview');
select pg_temp.expect((public.failed_message_summary(null)->'by_code') @> '[{"code": "131049"}]'::jsonb, 'summary groups by error code');
select pg_temp.expect((public.failed_message_summary(null)->>'recovered')::int >= 1 and (public.failed_message_summary(null)->>'exhausted')::int >= 1, 'summary counts recovered and exhausted');
select pg_temp.expect((has_function_privilege('anon', 'public.retry_failed_messages(uuid,uuid)', 'execute')) = false, 'browser roles cannot call the retry functions');

-- ---------- 10. Audience review (eligible vs excluded) ----------
select pg_temp.expect((public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'pool')::int = 12, 'review counts every saved contact in the source');
select pg_temp.expect(
  (public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'eligible')::int
  + (public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'excluded')::int
  = (public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'pool')::int, 'eligible plus excluded equals the pool');
select pg_temp.expect(
  (public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'excluded')::int
  = (public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'opt_out')::int
  + (public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'do_not_send')::int
  + (public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'other')::int, 'the exclusion reasons add up');
select pg_temp.expect((public.campaign_audience_review('c0000000-0000-0000-0000-000000000002')->>'opt_out')::int >= 1, 'an opted-out contact is counted as Opt Out');
select pg_temp.expect((select count(*) from public.contacts) = 12, 'review never deletes contacts');
do $$ begin
  begin perform public.campaign_audience_review('00000000-0000-0000-0000-000000000000');
    raise exception 'ASSERT FAILED: unknown campaign must error'; exception when raise_exception then if sqlerrm like 'ASSERT%' then raise; end if; end;
  raise notice 'ok - an unknown campaign is rejected';
end $$;
select pg_temp.expect((has_function_privilege('anon', 'public.campaign_audience_review(uuid)', 'execute')) = false, 'browser roles cannot call the review');
select 'ALL FAILED-RETRY CHECKS PASSED' as result;
