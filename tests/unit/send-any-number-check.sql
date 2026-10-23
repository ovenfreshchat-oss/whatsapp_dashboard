-- Integration check for drizzle/0008_send_to_any_saved_number.sql, run against a DISPOSABLE empty
-- Postgres database from the repository root:
--   psql -X -d scratch_db -f tests/unit/send-any-number-check.sql
-- Asserts: a saved number with no consent record is sendable, a STOP number is not, and campaign
-- drafts capture them (all contacts, and a specific import batch).
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
\i drizzle/0008_send_to_any_saved_number.sql
\i drizzle/0008_send_to_any_saved_number.sql

create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$ begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111');
insert into public.contacts(phone_e164) values ('+919000000001'), ('+919000000002'), ('+919000000003');
insert into public.contact_import_batches(id, import_key, request_sha256, actor_user_id, file_name, file_kind, file_sha256,
  total_rows, accepted_rows, inserted_contacts)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', gen_random_uuid(), repeat('a',64), '11111111-1111-1111-1111-111111111111',
  'b.csv', 'csv', repeat('b',64), 2, 2, 2);
select pg_temp.expect(public.link_import_batch_contacts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111', array['+919000000001','+919000000002']) = 2, 'batch linked 2 contacts');

select pg_temp.expect(public.can_send_whatsapp_marketing((select id from public.contacts where phone_e164='+919000000001'), 'W1', 'P1'),
  'saved number without consent record is sendable');

insert into public.meta_opt_outs(waba_id, phone_number_id, identity_type, identity_value, source_item_key)
values ('W1', 'P1', 'whatsapp_from', '919000000002', repeat('c',64))
on conflict do nothing;
select pg_temp.expect(not public.can_send_whatsapp_marketing((select id from public.contacts where phone_e164='+919000000002'), 'W1', 'P1'),
  'STOP number is not sendable');

select pg_temp.expect((select audience_count from public.create_whatsapp_campaign_draft(
  '11111111-1111-1111-1111-111111111111','All','W1','P1','T1','offer','en','{}'::jsonb,'[]'::jsonb,null,true)) = 2,
  'all-contacts draft captures 2 (STOP excluded)');
select pg_temp.expect((select audience_count from public.create_whatsapp_campaign_draft(
  '11111111-1111-1111-1111-111111111111','Batch','W1','P1','T1','offer','en','{}'::jsonb,'[]'::jsonb,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',false)) = 1,
  'batch draft captures 1 (STOP excluded, unlinked excluded)');
