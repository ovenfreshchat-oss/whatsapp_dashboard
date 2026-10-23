-- Integration check for drizzle/0007_import_opt_in_attestation.sql, run against a DISPOSABLE empty
-- Postgres database from the repository root:
--   psql -X -d scratch_db -f tests/unit/import-attestation-check.sql
-- It creates stand-ins for Supabase roles and auth.users, applies 0001, 0002 and 0007 (0007 twice),
-- then asserts that attestation grants consent but never overrides an opt-out.
-- Refuses to run if the Meta tables already exist.
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
\i drizzle/0007_import_opt_in_attestation.sql
\i drizzle/0007_import_opt_in_attestation.sql

create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$ begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.sendable(p text) returns boolean language sql as $$
  select public.can_send_whatsapp_marketing((select id from public.contacts where phone_e164 = p), 'W1', 'P1') $$;

insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');

-- A phone-only import: no consent column, so nothing is eligible yet.
create temp table imp as select public.import_contact_batch(
  'aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111',
  'phones.csv', 'csv', repeat('b', 64),
  '[{"row_number":2,"phone_e164":"+14165550101"},{"row_number":3,"phone_e164":"+14165550102"},{"row_number":4,"phone_e164":"+14165550103"},{"row_number":5,"phone_e164":"+14165550104"}]'::jsonb,
  '[]'::jsonb) as j;
select pg_temp.expect((select (j->>'inserted')::int from imp) = 4, 'four contacts imported');
select pg_temp.expect(not pg_temp.sendable('+14165550101'), 'imported contact is not eligible before attestation');

-- 0102 has a manual suppression; 0103 replied STOP on WhatsApp.
insert into public.contact_marketing_suppressions(phone_e164, reason, source) values ('+14165550102', 'manual_opt_out', 'test');
insert into public.meta_opt_outs(waba_id, phone_number_id, identity_value, source_item_key)
  values ('W1', 'P1', '14165550103', repeat('c', 64));

create temp table att as select public.attest_contacts_opt_in(
  (select (j->>'batch_id')::uuid from imp), '11111111-1111-1111-1111-111111111111',
  array['+14165550101','+14165550102','+14165550103','+14165550104','+14165550101','not a phone','+14165559999']) as j;
select pg_temp.expect((select (j->>'granted')::int from att) = 2, 'two clean contacts granted');
select pg_temp.expect((select (j->>'skipped_opted_out')::int from att) = 2, 'suppressed and STOP contacts skipped');
select pg_temp.expect((select (j->>'skipped_unknown')::int from att) = 2, 'invalid and unknown phones skipped');
select pg_temp.expect(pg_temp.sendable('+14165550101') and pg_temp.sendable('+14165550104'), 'attested contacts are eligible');
select pg_temp.expect(not pg_temp.sendable('+14165550102'), 'manual opt-out still blocks');
select pg_temp.expect(not pg_temp.sendable('+14165550103'), 'WhatsApp STOP still blocks');

select pg_temp.expect((select count(*) from public.contact_consent_events where verification_status='verified' and decision='grant'
  and reviewed_by = '11111111-1111-1111-1111-111111111111' and evidence_reference like 'contact import %' and source = 'Administrator attestation at import') = 2,
  'audit trail names the administrator, batch, and source');

-- Rerun is idempotent
create temp table att2 as select public.attest_contacts_opt_in(
  (select (j->>'batch_id')::uuid from imp), '11111111-1111-1111-1111-111111111111',
  array['+14165550101','+14165550104']) as j;
select pg_temp.expect((select (j->>'granted')::int from att2) = 0 and (select (j->>'already_attested')::int from att2) = 2, 'repeat attestation grants nothing new');
select pg_temp.expect((select count(*) from public.contact_consent_events) = 2, 'no duplicate consent events');

-- Another administrator cannot attest this batch
do $$ begin
  perform public.attest_contacts_opt_in((select (j->>'batch_id')::uuid from imp), '22222222-2222-2222-2222-222222222222', array['+14165550101']);
  raise exception 'should fail';
exception when others then if sqlerrm <> 'Import batch does not belong to this administrator' then raise; end if; end $$;
select pg_temp.expect(true, 'other administrator rejected');
do $$ begin
  perform public.attest_contacts_opt_in((select (j->>'batch_id')::uuid from imp), '11111111-1111-1111-1111-111111111111', array[]::text[]);
  raise exception 'should fail';
exception when others then if sqlerrm <> 'Invalid opt-in attestation' then raise; end if; end $$;
select pg_temp.expect(true, 'empty phone list rejected');

-- A later revoke wins, and re-attesting cannot undo it
select public.record_contact_consent('dddddddd-0000-4000-8000-000000000001', (select id from public.contacts where phone_e164='+14165550101'),
  'revoke', 'customer asked', null, null, now(), '11111111-1111-1111-1111-111111111111');
select pg_temp.expect(not pg_temp.sendable('+14165550101'), 'revoked contact is blocked');
create temp table att3 as select public.attest_contacts_opt_in(
  (select (j->>'batch_id')::uuid from imp), '11111111-1111-1111-1111-111111111111', array['+14165550101']) as j;
select pg_temp.expect((select (j->>'granted')::int from att3) = 0, 'attestation does not re-grant a revoked contact');
select pg_temp.expect(not pg_temp.sendable('+14165550101'), 'revoked contact stays blocked after attestation');

-- Not callable by logged-in users
set role authenticated;
do $$ begin
  perform public.attest_contacts_opt_in(gen_random_uuid(), gen_random_uuid(), array['+14165550101']);
  raise exception 'should fail';
exception when insufficient_privilege then null; end $$;
reset role;
select pg_temp.expect(true, 'authenticated role cannot call it');
\echo ALL CHECKS PASSED
