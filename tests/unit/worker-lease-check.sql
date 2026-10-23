-- Integration check for drizzle/0011_campaign_worker_lease.sql, run against a DISPOSABLE empty
-- Postgres database from the repository root:
--   psql -X -d scratch_db -f tests/unit/worker-lease-check.sql
-- Asserts: one holder at a time, the holder can renew, an expired lease can be taken over,
-- release frees it, bad input is rejected, and the status RPC reports pending work correctly.
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
\i drizzle/0011_campaign_worker_lease.sql
\i drizzle/0011_campaign_worker_lease.sql

create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$ begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

select pg_temp.expect(public.acquire_campaign_worker_lease('run-a', 120), 'first holder takes the lease');
select pg_temp.expect(not public.acquire_campaign_worker_lease('run-b', 120), 'second holder is refused while the lease is valid');
select pg_temp.expect(public.acquire_campaign_worker_lease('run-a', 120), 'the holder can renew its own lease');

update public.campaign_worker_lease set expires_at = now() - interval '1 second';
select pg_temp.expect(public.acquire_campaign_worker_lease('run-b', 120), 'an expired lease can be taken over');
select pg_temp.expect(not public.acquire_campaign_worker_lease('run-a', 120), 'the old holder is refused after takeover');

select public.release_campaign_worker_lease('run-a');
select pg_temp.expect(not public.acquire_campaign_worker_lease('run-a', 120), 'releasing as a non-holder changes nothing');
select public.release_campaign_worker_lease('run-b');
select pg_temp.expect(public.acquire_campaign_worker_lease('run-a', 120), 'release by the holder frees the lease');

do $$ begin
  begin perform public.acquire_campaign_worker_lease('', 120);
    raise exception 'ASSERT FAILED: empty holder accepted';
  exception when others then
    if sqlerrm like 'ASSERT FAILED%' then raise; end if; raise notice 'ok - empty holder rejected'; end;
  begin perform public.acquire_campaign_worker_lease('x', 5);
    raise exception 'ASSERT FAILED: tiny ttl accepted';
  exception when others then
    if sqlerrm like 'ASSERT FAILED%' then raise; end if; raise notice 'ok - out-of-range ttl rejected'; end;
end $$;

-- Status RPC
select pg_temp.expect(public.campaign_worker_status() = '{"in_flight": false, "running_pending": false, "next_scheduled_at": null}'::jsonb,
  'empty system reports no work');

insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111');
insert into public.contacts(phone_e164) values ('+919000000001'), ('+919000000002');
select public.create_whatsapp_campaign_draft('11111111-1111-1111-1111-111111111111', 'c1', 'W1', 'P1', 't1', 'tmpl', 'en_US',
  '{}'::jsonb, '[]'::jsonb, null, true);
update public.whatsapp_campaigns set state = 'scheduled', scheduled_for = now() + interval '1 hour' where name = 'c1';
select pg_temp.expect((public.campaign_worker_status()->>'next_scheduled_at') is not null
  and (public.campaign_worker_status()->>'running_pending')::boolean = false, 'scheduled campaign shows next_scheduled_at only');
update public.whatsapp_campaigns set state = 'running' where name = 'c1';
select pg_temp.expect((public.campaign_worker_status()->>'running_pending')::boolean = true
  and (public.campaign_worker_status()->>'next_scheduled_at') is null, 'running campaign with pending recipients shows running_pending');
update public.whatsapp_campaign_recipients set state = 'in_flight';
select pg_temp.expect((public.campaign_worker_status()->>'in_flight')::boolean = true
  and (public.campaign_worker_status()->>'running_pending')::boolean = false, 'claimed recipients show in_flight');
update public.whatsapp_campaign_recipients set state = 'accepted';
select pg_temp.expect((public.campaign_worker_status()->>'in_flight')::boolean = false
  and (public.campaign_worker_status()->>'running_pending')::boolean = false, 'finished recipients show no work');
