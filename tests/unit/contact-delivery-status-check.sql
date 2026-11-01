-- Integration check for drizzle/0025_contact_delivery_status.sql (and the 0024 opt-out sync), run
-- against a DISPOSABLE empty Postgres database from the repository root:
--   psql -X -d scratch_db -f tests/unit/contact-delivery-status-check.sql
-- Asserts the failure log, every status rule (131026, 131049, 131056, 131050, engagement), manual
-- reactivation, the time-based cooldowns, idempotency, and that Do Not Send contacts are not sendable.
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
\i drizzle/0013_auto_opt_out_numbers.sql
\i drizzle/0014_direct_stop_handling.sql
\i drizzle/0016_campaign_analytics.sql
\i drizzle/0018_fix_delivery_status_projection.sql
\i drizzle/0019_no_sender_holds.sql
\i drizzle/0020_contact_campaign_active.sql
\i drizzle/0024_failed_numbers_to_opt_outs.sql
\i drizzle/0025_contact_delivery_status.sql

create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$
begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111');
insert into public.meta_webhook_envelopes (id, payload_sha256) values ('22222222-2222-2222-2222-222222222222', repeat('a', 64));

-- Three campaigns (the same sender) and one contact per scenario.
insert into public.whatsapp_campaigns (id, created_by, name, audience_source, audience_source_label, waba_id, phone_number_id,
  template_id, template_name, template_language, template_snapshot, state, audience_count)
select ('c0000000-0000-0000-0000-00000000000' || n)::uuid, '11111111-1111-1111-1111-111111111111', 'Campaign ' || n,
  'all_eligible', 'All', 'W1', 'P1', 't1', 'tpl', 'en', '{}', 'completed', 9 from generate_series(1, 3) n;

-- phones: A 1 (3 campaigns 131049), B 2 (2 campaigns), C 3 (131026), D 4 (131056), E 5 (131050), F 6 (131049 then read),
--         G 7 (read only), H 8 (inbound only), I 9 (nothing), J 10 (old 131049 x3 >90d), K 11 (131048 only)
insert into public.contacts (id, phone_e164)
select ('d0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, '+1647000' || lpad(n::text, 4, '0')
from generate_series(1, 11) n;

create function pg_temp.contact(n int) returns uuid language sql as
$$ select ('d0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid $$;
create function pg_temp.phone(n int) returns text language sql as $$ select '+1647000' || lpad(n::text, 4, '0') $$;

create function pg_temp.recipient(c int, n int, wamid text) returns void language sql as $$
  insert into public.whatsapp_campaign_recipients (campaign_id, contact_id, recipient_e164, state, wamid)
  values (('c0000000-0000-0000-0000-00000000000' || c)::uuid, pg_temp.contact(n), pg_temp.phone(n), 'accepted', wamid)
$$;

create function pg_temp.fail(wamid text, code int, at timestamptz, key text) returns void language sql as $$
  insert into public.meta_webhook_items (envelope_id, dedupe_key, kind, waba_id, phone_number_id, field,
    provider_message_id, provider_status, event_timestamp, payload)
  values ('22222222-2222-2222-2222-222222222222', encode(sha256(key::bytea), 'hex'), 'status', 'W1', 'P1', 'messages',
    wamid, 'failed', at, jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('code', code, 'title', 'err ' || code))))
$$;

create function pg_temp.status(n int, at timestamptz default now()) returns text language sql as
$$ select status from public.contact_delivery_state(pg_temp.phone(n), at) $$;

-- A: 131049 in three distinct campaigns; B: two; C: 131026
select pg_temp.recipient(1, 1, 'wa1'); select pg_temp.recipient(2, 1, 'wa2'); select pg_temp.recipient(3, 1, 'wa3');
select pg_temp.recipient(1, 2, 'wb1'); select pg_temp.recipient(2, 2, 'wb2');
select pg_temp.recipient(1, 3, 'wc1');
select pg_temp.fail('wa1', 131049, now() - interval '20 days', 'wa1'); select pg_temp.fail('wa2', 131049, now() - interval '10 days', 'wa2');
select pg_temp.fail('wa3', 131049, now() - interval '2 days', 'wa3');
select pg_temp.fail('wb1', 131049, now() - interval '10 days', 'wb1'); select pg_temp.fail('wb2', 131049, now() - interval '2 days', 'wb2');
select pg_temp.fail('wc1', 131026, now() - interval '1 day', 'wc1');

select pg_temp.expect((select count(*) from public.contact_delivery_failures) = 6, 'every failed campaign message is logged once');
select pg_temp.fail('wa3', 131049, now() - interval '2 days', 'wa3-duplicate');
select pg_temp.expect((select count(*) from public.contact_delivery_failures where wamid = 'wa3') = 1, 'a repeated webhook does not log twice');
select pg_temp.fail('unknown-wamid', 131049, now(), 'unknown');
select pg_temp.expect((select count(*) from public.contact_delivery_failures) = 6, 'a failure for an unknown message is ignored without error');

select pg_temp.expect(pg_temp.status(1) = 'do_not_send' and (select reason from public.contact_delivery_state(pg_temp.phone(1))) = 'repeated_131049',
  '131049 in 3 distinct campaigns is Do Not Send');
select pg_temp.expect((select review_due_at from public.contact_delivery_state(pg_temp.phone(1))) = (select max(failed_at) + interval '30 days' from public.contact_delivery_failures where phone_e164 = pg_temp.phone(1)),
  'repeated 131049 review is due 30 days after the latest failure');
select pg_temp.expect(pg_temp.status(2) = 'at_risk', '131049 in 2 campaigns is At Risk, still eligible');
select pg_temp.expect(pg_temp.status(3) = 'do_not_send', '131026 is Do Not Send until reviewed');
select pg_temp.expect(pg_temp.status(3, now() + interval '400 days') = 'do_not_send', '131026 never expires on its own');

-- J: three 131049 failures, all older than 90 days, do not count
select pg_temp.recipient(1, 10, 'wj1'); select pg_temp.recipient(2, 10, 'wj2'); select pg_temp.recipient(3, 10, 'wj3');
select pg_temp.fail('wj1', 131049, now() - interval '130 days', 'wj1'); select pg_temp.fail('wj2', 131049, now() - interval '120 days', 'wj2');
select pg_temp.fail('wj3', 131049, now() - interval '110 days', 'wj3');
select pg_temp.expect(pg_temp.status(10) = 'other', 'failures older than 90 days no longer count');

-- Sendability uses the same status
select pg_temp.expect(not public.can_send_whatsapp_marketing(pg_temp.contact(1), 'W1', 'P1'), 'Do Not Send (131049 x3) is not sendable');
select pg_temp.expect(not public.can_send_whatsapp_marketing(pg_temp.contact(3), 'W1', 'P1'), 'Do Not Send (131026) is not sendable');
select pg_temp.expect(public.can_send_whatsapp_marketing(pg_temp.contact(2), 'W1', 'P1'), 'At Risk stays sendable');
select pg_temp.expect(public.can_send_whatsapp_marketing(pg_temp.contact(9), 'W1', 'P1'), 'a contact with no failures stays sendable');

-- Manual reactivation
select pg_temp.expect(public.reactivate_contact_delivery(pg_temp.phone(3), '11111111-1111-1111-1111-111111111111', 'verified'), 'reactivation succeeds');
select pg_temp.expect(pg_temp.status(3) = 'other', 'after reactivation earlier failures stop counting');
select pg_temp.expect(public.can_send_whatsapp_marketing(pg_temp.contact(3), 'W1', 'P1'), 'a reactivated contact is sendable again');
select pg_temp.recipient(2, 3, 'wc2');
select pg_temp.fail('wc2', 131026, clock_timestamp(), 'wc2');
select pg_temp.expect(pg_temp.status(3) = 'do_not_send', 'a new 131026 after reactivation blocks again');

-- D: 131056 cooldowns 24h, 72h, 7d, 14d, then reset after 30 quiet days
select pg_temp.recipient(1, 4, 'wd1');
select pg_temp.fail('wd1', 131056, timestamptz '2026-01-01 00:00+00', 'wd1');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-01-01 23:00+00') = 'do_not_send', '1st 131056: blocked inside 24h');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-01-02 01:00+00') <> 'do_not_send', '1st 131056: free after 24h');
select pg_temp.recipient(2, 4, 'wd2'); select pg_temp.fail('wd2', 131056, timestamptz '2026-01-05 00:00+00', 'wd2');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-01-07 23:00+00') = 'do_not_send', '2nd 131056: blocked inside 72h');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-01-08 01:00+00') <> 'do_not_send', '2nd 131056: free after 72h');
select pg_temp.recipient(3, 4, 'wd3'); select pg_temp.fail('wd3', 131056, timestamptz '2026-01-10 00:00+00', 'wd3');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-01-16 23:00+00') = 'do_not_send', '3rd 131056: blocked inside 7 days');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-01-17 01:00+00') <> 'do_not_send', '3rd 131056: free after 7 days');
insert into public.whatsapp_campaigns (id, created_by, name, audience_source, audience_source_label, waba_id, phone_number_id, template_id, template_name, template_language, template_snapshot, state, audience_count)
values ('c0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Campaign 4', 'all_eligible', 'All', 'W1', 'P1', 't1', 'tpl', 'en', '{}', 'completed', 9);
select pg_temp.recipient(4, 4, 'wd4'); select pg_temp.fail('wd4', 131056, timestamptz '2026-01-20 00:00+00', 'wd4');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-02-02 23:00+00') = 'do_not_send', '4th 131056: blocked inside 14 days');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-02-03 01:00+00') <> 'do_not_send', '4th 131056: free after 14 days');
insert into public.whatsapp_campaigns (id, created_by, name, audience_source, audience_source_label, waba_id, phone_number_id, template_id, template_name, template_language, template_snapshot, state, audience_count)
values ('c0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Campaign 5', 'all_eligible', 'All', 'W1', 'P1', 't1', 'tpl', 'en', '{}', 'completed', 9);
select pg_temp.recipient(5, 4, 'wd5'); select pg_temp.fail('wd5', 131056, timestamptz '2026-03-15 00:00+00', 'wd5');
select pg_temp.expect(pg_temp.status(4, timestamptz '2026-03-15 23:00+00') = 'do_not_send'
  and (select hold_until from public.contact_delivery_state(pg_temp.phone(4), timestamptz '2026-03-15 23:00+00')) = timestamptz '2026-03-16 00:00+00',
  '131056 after 30 quiet days starts again at 24h');

-- E: 131050 goes on the global opt-out list (0024); 131049 must NOT
select pg_temp.recipient(1, 5, 'we1');
select pg_temp.fail('we1', 131050, now(), 'we1');
select pg_temp.expect(exists (select 1 from public.opt_out_numbers where phone_e164 = pg_temp.phone(5) and released_at is null), '131050 is added to the opt-out list');
select pg_temp.expect(pg_temp.status(5) = 'opt_out', '131050 contact is Opt Out');
select pg_temp.expect(not exists (select 1 from public.opt_out_numbers where phone_e164 in (pg_temp.phone(1), pg_temp.phone(2), pg_temp.phone(3))),
  '131049 and 131026 are never added to the opt-out list');

-- F: 131049 then a read afterwards is Active; G: read only; H: inbound only; I: nothing; K: 131048 only
select pg_temp.recipient(1, 6, 'wf1'); select pg_temp.fail('wf1', 131049, now() - interval '5 days', 'wf1');
select pg_temp.expect(pg_temp.status(6) = 'at_risk', '131049 with no engagement is At Risk');
select pg_temp.recipient(2, 6, 'wf2');
update public.whatsapp_campaign_recipients set delivery_status = 'read', last_status_at = now() - interval '1 day' where wamid = 'wf2';
select pg_temp.expect(pg_temp.status(6) = 'active', 'reading a message after the failure makes the contact Active');
select pg_temp.recipient(1, 7, 'wg1');
update public.whatsapp_campaign_recipients set delivery_status = 'read', last_status_at = now() - interval '3 days' where wamid = 'wg1';
select pg_temp.expect(pg_temp.status(7) = 'active', 'a read in the last 30 days is Active');
select pg_temp.expect(pg_temp.status(7, now() + interval '40 days') = 'other', 'a read older than 30 days is not Active');
insert into public.meta_webhook_items (envelope_id, dedupe_key, kind, waba_id, phone_number_id, field, provider_message_id, event_timestamp, payload)
values ('22222222-2222-2222-2222-222222222222', repeat('b', 64), 'message', 'W1', 'P1', 'messages', 'in-1', now() - interval '2 days',
  jsonb_build_object('from', substring(pg_temp.phone(8) from 2), 'type', 'button', 'button', jsonb_build_object('text', 'Order')));
select pg_temp.expect(pg_temp.status(8) = 'active', 'an inbound message or button tap in the last 30 days is Active');
select pg_temp.expect(pg_temp.status(9) = 'other', 'no failures and no engagement is neither Active nor At Risk');
select pg_temp.recipient(1, 11, 'wk1'); select pg_temp.fail('wk1', 131048, now(), 'wk1');
select pg_temp.expect(pg_temp.status(11) = 'other' and exists (select 1 from public.contact_delivery_failures where error_code = '131048'),
  '131048 is logged but never changes a contact status');

-- Counts for the five cards, and the view
select pg_temp.expect((public.contact_status_counts()->>'total')::int = 11, 'total counts every saved contact');
select pg_temp.expect((public.contact_status_counts()->>'do_not_send')::int = 2, 'Do Not Send count (A repeated 131049, C after a new 131026)');
select pg_temp.expect((public.contact_status_counts()->>'opt_out')::int = 1, 'opt-out count is the global list');
select pg_temp.expect((select count(*) from public.contact_delivery_status) = 11, 'the view returns one row per contact');
select pg_temp.expect(not has_table_privilege('authenticated', 'public.contact_delivery_failures', 'select'), 'browser roles cannot read the failure log');
\echo ALL CHECKS PASSED
