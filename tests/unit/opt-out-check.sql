-- Integration check for drizzle/0010_opt_out_numbers.sql, run against a DISPOSABLE empty
-- Postgres database from the repository root:
--   psql -X -d scratch_db -f tests/unit/opt-out-check.sql
-- Asserts: an opted-out number is not sendable, others are, released numbers are sendable again,
-- re-adding re-activates, bulk add counts are right, drafts exclude listed numbers, and a recipient
-- already in a draft is suppressed by the send-time gate once added to the list.
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
\i drizzle/0010_opt_out_numbers.sql
\i drizzle/0010_opt_out_numbers.sql

create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$ begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111');
insert into public.contacts(phone_e164) values ('+919000000001'), ('+919000000002'), ('+919000000003');

select pg_temp.expect((public.add_opt_out_numbers(array['+919000000001','+919000000001','+919000000009'], 'test',
  '11111111-1111-1111-1111-111111111111')->>'added')::int = 2, 'bulk add dedupes and counts 2 new');
select pg_temp.expect((public.add_opt_out_numbers(array['+919000000001'], 'again',
  '11111111-1111-1111-1111-111111111111')->>'already_listed')::int = 1, 'adding a listed number reports already_listed');

select pg_temp.expect(not public.can_send_whatsapp_marketing((select id from public.contacts where phone_e164='+919000000001'), 'W1', 'P1'),
  'opted-out contact is not sendable');
select pg_temp.expect(public.can_send_whatsapp_marketing((select id from public.contacts where phone_e164='+919000000002'), 'W1', 'P1'),
  'other contact is sendable');

select pg_temp.expect(public.release_opt_out_number((select id from public.opt_out_numbers where phone_e164='+919000000001'),
  '11111111-1111-1111-1111-111111111111'), 'release returns true');
select pg_temp.expect(public.can_send_whatsapp_marketing((select id from public.contacts where phone_e164='+919000000001'), 'W1', 'P1'),
  'released contact is sendable again');
select pg_temp.expect((public.add_opt_out_numbers(array['+919000000001'], 'again',
  '11111111-1111-1111-1111-111111111111')->>'reactivated')::int = 1, 're-adding a released number re-activates it');
select pg_temp.expect(not public.can_send_whatsapp_marketing((select id from public.contacts where phone_e164='+919000000001'), 'W1', 'P1'),
  're-activated contact is not sendable');

do $$ begin
  begin perform public.add_opt_out_numbers(array['12345'], 'x', '11111111-1111-1111-1111-111111111111');
    raise exception 'ASSERT FAILED: invalid number accepted';
  exception when others then
    if sqlerrm like 'ASSERT FAILED%' then raise; end if;
    raise notice 'ok - invalid number rejected';
  end;
end $$;

-- Audience capture: a draft for all contacts must exclude the opted-out number.
select public.create_whatsapp_campaign_draft('11111111-1111-1111-1111-111111111111', 'c1', 'W1', 'P1', 't1', 'tmpl', 'en_US',
  '{}'::jsonb, '[]'::jsonb, null, true);
select pg_temp.expect((select audience_count from public.whatsapp_campaigns where name='c1') = 2,
  'draft audience excludes the opted-out number (2 of 3 contacts)');
select pg_temp.expect(not exists (select 1 from public.whatsapp_campaign_recipients where recipient_e164='+919000000001'),
  'opted-out number is not a campaign recipient');

-- Send-time gate: a number added to the list AFTER the audience was frozen is suppressed at send time.
update public.whatsapp_campaigns set state = 'running' where name = 'c1';
update public.whatsapp_campaign_recipients set state = 'in_flight'
  where campaign_id = (select id from public.whatsapp_campaigns where name = 'c1');
select pg_temp.expect(public.whatsapp_campaign_send_gate((select id from public.whatsapp_campaign_recipients where recipient_e164='+919000000002')) = 'allowed',
  'send gate allows a number that is not on the list');
select public.add_opt_out_numbers(array['+919000000002'], 'late opt-out', '11111111-1111-1111-1111-111111111111');
select pg_temp.expect(public.whatsapp_campaign_send_gate((select id from public.whatsapp_campaign_recipients where recipient_e164='+919000000002')) = 'suppressed',
  'send gate suppresses a number added to the list after the draft was created');
select pg_temp.expect(public.whatsapp_campaign_send_gate((select id from public.whatsapp_campaign_recipients where recipient_e164='+919000000003')) = 'allowed',
  'send gate still allows the other recipient');
