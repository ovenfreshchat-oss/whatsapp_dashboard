-- Integration check for drizzle/0012_campaign_send_throttle.sql, run against a DISPOSABLE empty
-- Postgres database from the repository root:
--   psql -X -d scratch_db -f tests/unit/send-throttle-check.sql
-- Asserts the "send 15, then cool down 30 minutes" behaviour from the send-attempt log.
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
\i drizzle/0012_campaign_send_throttle.sql
\i drizzle/0012_campaign_send_throttle.sql

create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$ begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.allowed() returns int language sql as $$ select (public.campaign_send_throttle(15, 30)->>'allowed')::int $$;
-- p_n attempts of one state; the first started p_first ago, each later one p_step after the previous;
-- p_skip recipients are skipped first so scenarios can add attempts for different recipients.
create function pg_temp.add_attempts(p_n int, p_state text, p_first interval, p_step interval, p_skip int default 0)
returns void language sql as $$
  insert into public.whatsapp_campaign_send_attempts (recipient_id, attempt_number, state, started_at)
  select id, 1, p_state, now() - p_first + (rn - p_skip - 1) * p_step
  from (select id, row_number() over (order by id) rn from public.whatsapp_campaign_recipients) r
  where rn > p_skip and rn <= p_skip + p_n;
$$;

insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111');
insert into public.contacts(phone_e164) select '+9190000' || lpad(i::text, 5, '0') from generate_series(1, 40) i;
select public.create_whatsapp_campaign_draft('11111111-1111-1111-1111-111111111111', 'c1', 'W1', 'P1', 't1', 'tmpl', 'en_US',
  '{}'::jsonb, '[]'::jsonb, null, true);
select pg_temp.expect((select count(*) from public.whatsapp_campaign_recipients) = 40, 'fixture has 40 recipients');

select pg_temp.expect(pg_temp.allowed() = 15 and public.campaign_send_throttle(15, 30)->'wait_until' = 'null'::jsonb,
  'no sends yet: a full batch of 15 is allowed');

select pg_temp.add_attempts(5, 'accepted', interval '2 minutes', interval '10 seconds');
select pg_temp.expect(pg_temp.allowed() = 10, '5 sent in this batch: 10 more allowed');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.add_attempts(15, 'accepted', interval '5 minutes', interval '10 seconds');
select pg_temp.expect(pg_temp.allowed() = 0, '15 sent: nothing more allowed');
select pg_temp.expect(
  abs(extract(epoch from ((public.campaign_send_throttle(15, 30)->>'wait_until')::timestamptz
    - ((select max(started_at) from public.whatsapp_campaign_send_attempts) + interval '30 minutes')))) < 1,
  'cooldown ends 30 minutes after the last send');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.add_attempts(15, 'accepted', interval '50 minutes', interval '10 seconds');
select pg_temp.expect(pg_temp.allowed() = 15, 'last send was over 30 minutes ago: a fresh batch of 15');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.add_attempts(15, 'accepted', interval '3 hours', interval '10 seconds');
select pg_temp.add_attempts(3, 'accepted', interval '5 minutes', interval '10 seconds', 15);
select pg_temp.expect(pg_temp.allowed() = 12, 'only the sends since the last cooldown count (3 sent: 12 left)');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.add_attempts(20, 'rejected', interval '2 minutes', interval '1 second');
select pg_temp.add_attempts(2, 'accepted', interval '1 minute', interval '10 seconds', 20);
select pg_temp.expect(pg_temp.allowed() = 13, 'skipped or rejected attempts do not use up the batch');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.add_attempts(14, 'in_flight', interval '1 minute', interval '1 second');
select pg_temp.expect(pg_temp.allowed() = 1, 'claimed (in-flight) sends count, so a crash cannot exceed the batch');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.add_attempts(2, 'uncertain', interval '1 minute', interval '10 seconds');
select pg_temp.expect(pg_temp.allowed() = 13, 'uncertain sends count too');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.add_attempts(30, 'accepted', interval '10 minutes', interval '10 seconds');
select pg_temp.expect(pg_temp.allowed() = 0, 'a batch already larger than the limit (sent before the throttle) is cooled down');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.add_attempts(5, 'accepted', interval '170 minutes', interval '40 minutes');
select pg_temp.expect(pg_temp.allowed() = 14, 'slow sending with gaps over 30 minutes: each send starts its own batch');
delete from public.whatsapp_campaign_send_attempts;

select pg_temp.expect((public.campaign_send_throttle(1, 1)->>'allowed')::int = 1, 'throttle of 1 per 1 minute: first send allowed');
select pg_temp.add_attempts(1, 'accepted', interval '10 seconds', interval '1 second');
select pg_temp.expect((public.campaign_send_throttle(1, 1)->>'allowed')::int = 0, 'throttle of 1 per 1 minute: second send blocked');
delete from public.whatsapp_campaign_send_attempts;

do $$ begin
  begin perform public.campaign_send_throttle(0, 30); raise exception 'ASSERT FAILED: batch 0 accepted';
  exception when others then if sqlerrm like 'ASSERT FAILED%' then raise; end if; raise notice 'ok - batch 0 rejected'; end;
  begin perform public.campaign_send_throttle(15, 0); raise exception 'ASSERT FAILED: cooldown 0 accepted';
  exception when others then if sqlerrm like 'ASSERT FAILED%' then raise; end if; raise notice 'ok - cooldown 0 rejected'; end;
  begin perform public.campaign_send_throttle(501, 30); raise exception 'ASSERT FAILED: batch 501 accepted';
  exception when others then if sqlerrm like 'ASSERT FAILED%' then raise; end if; raise notice 'ok - batch 501 rejected'; end;
end $$;
