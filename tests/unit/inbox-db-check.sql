-- Integration check for drizzle/0006_inbox.sql, run against a DISPOSABLE empty Postgres database.
-- It creates stand-ins for Supabase's roles and auth.users, applies 0001 and 0006 (twice, to prove
-- 0006 is rerunnable), then asserts inbox behaviour. Run from the repository root:
--   psql -X -d scratch_db -f tests/unit/inbox-db-check.sql
-- Never run this against a real project: it inserts test rows and refuses to run if the Meta tables exist.
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
insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111') on conflict do nothing;
-- A message stored BEFORE 0006 (backfill target), with profile name in the envelope.
select public.receive_meta_whatsapp_webhook(
  repeat('a',64),
  '{"object":"whatsapp_business_account","entry":[{"id":"W1","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"P1"},"contacts":[{"wa_id":"15551230001","profile":{"name":"Asha"}}],"messages":[{"id":"wamid.IN1","from":"15551230001","timestamp":"1792100000","type":"text","text":{"body":"Hello there"}}]}}]}]}'::jsonb,
  jsonb_build_array(jsonb_build_object('dedupe_key',repeat('1',64),'kind','message','waba_id','W1','phone_number_id','P1','field','messages','provider_message_id','wamid.IN1','event_timestamp','2026-10-16T00:00:00Z','needs_review',true,'payload','{"id":"wamid.IN1","from":"15551230001","timestamp":"1792100000","type":"text","text":{"body":"Hello there"}}'::jsonb)),
  '[]'::jsonb);
\i drizzle/0006_inbox.sql
\i drizzle/0006_inbox.sql
create function pg_temp.sha(t text) returns text language sql as $$ select encode(sha256(convert_to(t,'utf8')),'hex') $$;
create function pg_temp.expect(c boolean, msg text) returns void language plpgsql as $$ begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

create function pg_temp.recv_msg(env text, wamid text, from_ text, ts timestamptz, body text, name text default null)
returns void language plpgsql as $$
declare m jsonb := jsonb_build_object('id',wamid,'from',from_,'timestamp','1792100000','type','text','text',jsonb_build_object('body',body));
begin
  perform public.receive_meta_whatsapp_webhook(
    pg_temp.sha(env),
    jsonb_build_object('object','whatsapp_business_account','entry',jsonb_build_array(jsonb_build_object('id','W1','changes',jsonb_build_array(jsonb_build_object('field','messages','value',jsonb_build_object('metadata',jsonb_build_object('phone_number_id','P1'),'contacts',case when name is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('wa_id',from_,'profile',jsonb_build_object('name',name))) end,'messages',jsonb_build_array(m))))))),
    jsonb_build_array(jsonb_build_object('dedupe_key',pg_temp.sha('message:W1:P1:'||wamid),'kind','message','waba_id','W1','phone_number_id','P1','field','messages','provider_message_id',wamid,'event_timestamp',ts,'needs_review',true,'payload',m)),
    '[]'::jsonb);
end $$;

create function pg_temp.recv_stop(env text, wamid text, from_ text)
returns void language plpgsql as $$
declare m jsonb := jsonb_build_object('id',wamid,'from',from_,'timestamp','1792100000','type','text','text',jsonb_build_object('body','STOP'));
        k text := pg_temp.sha('message:W1:P1:'||wamid);
begin
  perform public.receive_meta_whatsapp_webhook(pg_temp.sha(env),
    jsonb_build_object('object','whatsapp_business_account','entry','[]'::jsonb),
    jsonb_build_array(jsonb_build_object('dedupe_key',k,'kind','message','waba_id','W1','phone_number_id','P1','field','messages','provider_message_id',wamid,'event_timestamp',now(),'needs_review',true,'payload',m)),
    jsonb_build_array(jsonb_build_object('waba_id','W1','phone_number_id','P1','identity_value',from_,'source_item_key',k,'source_message_id',wamid,'hold_only',false)));
end $$;

create function pg_temp.recv_status(env text, wamid text, st text, errors jsonb default null)
returns void language plpgsql as $$
declare s jsonb := jsonb_build_object('id',wamid,'status',st,'recipient_id','15551230001','timestamp','1792100001') || case when errors is null then '{}'::jsonb else jsonb_build_object('errors',errors) end;
begin
  perform public.receive_meta_whatsapp_webhook(pg_temp.sha(env),
    jsonb_build_object('object','whatsapp_business_account','entry','[]'::jsonb),
    jsonb_build_array(jsonb_build_object('dedupe_key',pg_temp.sha('status:'||env),'kind','status','waba_id','W1','phone_number_id','P1','field','messages','provider_message_id',wamid,'provider_status',st,'event_timestamp',now(),'needs_review',false,'payload',s)),
    '[]'::jsonb);
end $$;

-- 1. Backfill
select pg_temp.expect((select count(*) from public.inbox_conversations)=1, 'backfill created one conversation');
select pg_temp.expect((select profile_name from public.inbox_conversations)='Asha', 'backfill read profile name from envelope');
select pg_temp.expect((select unread_count from public.inbox_conversations)=1, 'backfill unread = 1');
select pg_temp.expect((select count(*) from public.inbox_messages where direction='inbound')=1, 'backfill one inbound message');

-- 2. Live inbound via trigger; duplicates do not double count
select pg_temp.recv_msg('env2','wamid.IN2','15551230001', now(), 'Is the offer still on?');
select pg_temp.expect((select unread_count from public.inbox_conversations)=2, 'live inbound increments unread');
select pg_temp.expect((select last_message_preview from public.inbox_conversations)='Is the offer still on?', 'preview updated');
select pg_temp.recv_msg('env2-rewrapped','wamid.IN2','15551230001', now(), 'Is the offer still on?');
select pg_temp.expect((select unread_count from public.inbox_conversations)=2, 'rewrapped duplicate does not double count');
select pg_temp.expect((select count(*) from public.inbox_messages)=2, 'still two messages');
select pg_temp.recv_msg('env2b','wamid.IN3','15551230002', now(), 'Hi', null);
select pg_temp.expect((select count(*) from public.inbox_conversations)=2, 'second customer gets own conversation');
select pg_temp.expect((select profile_name from public.inbox_conversations where wa_id='15551230002') is null, 'missing profile name stays null');

-- 3. Non-text types render placeholders
select pg_temp.expect(public.inbox_message_body('{"type":"image","image":{"id":"1"}}')='[Image]', 'image placeholder');
select pg_temp.expect(public.inbox_message_body('{"type":"image","image":{"caption":"Look"}}')='Look', 'image caption shown');
select pg_temp.expect(public.inbox_message_body('{"type":"interactive","interactive":{"button_reply":{"title":"Yes"}}}')='Yes', 'button reply title');
select pg_temp.expect(public.inbox_message_body('{"type":"weird"}')='[weird message]', 'unknown type placeholder');
select pg_temp.expect(public.inbox_message_body('{"type":"text","text":{"body":""}}')='[text message]', 'empty text placeholder');

-- 4. Reply reservation
\set actor '''11111111-1111-1111-1111-111111111111'''
create temp table ctx as select id from public.inbox_conversations where wa_id='15551230001';
create temp table r1 as select public.begin_inbox_reply((select id from ctx), '  Yes, until Sunday  ', 'aaaaaaaa-0000-0000-0000-000000000001', :actor::uuid) as j;
select pg_temp.expect((select (j->>'created')::boolean from r1), 'first reply reserved');
select pg_temp.expect((select body from public.inbox_messages where direction='outbound')='Yes, until Sunday', 'body trimmed');
select pg_temp.expect((select j->>'wa_id' from r1)='15551230001', 'returns recipient');
create temp table r1b as select public.begin_inbox_reply((select id from ctx), 'Yes, until Sunday', 'aaaaaaaa-0000-0000-0000-000000000001', :actor::uuid) as j;
select pg_temp.expect((select (j->>'created')::boolean from r1b)=false, 'same token is idempotent');
select pg_temp.expect((select count(*) from public.inbox_messages where direction='outbound')=1, 'no duplicate outbound row');

-- 5. Validation failures
do $$ begin perform public.begin_inbox_reply((select id from ctx), '   ', gen_random_uuid(), '11111111-1111-1111-1111-111111111111'); raise exception 'should fail'; exception when others then if sqlerrm <> 'invalid_reply' then raise; end if; end $$;
do $$ begin perform public.begin_inbox_reply((select id from ctx), repeat('x',4097), gen_random_uuid(), '11111111-1111-1111-1111-111111111111'); raise exception 'should fail'; exception when others then if sqlerrm <> 'invalid_reply' then raise; end if; end $$;
do $$ begin perform public.begin_inbox_reply(gen_random_uuid(), 'x', gen_random_uuid(), '11111111-1111-1111-1111-111111111111'); raise exception 'should fail'; exception when others then if sqlerrm <> 'conversation_missing' then raise; end if; end $$;
update public.inbox_conversations set last_inbound_at = now() - interval '24 hours 1 minute' where id=(select id from ctx);
do $$ begin perform public.begin_inbox_reply((select id from ctx), 'late', gen_random_uuid(), '11111111-1111-1111-1111-111111111111'); raise exception 'should fail'; exception when others then if sqlerrm <> 'window_closed' then raise; end if; end $$;
select pg_temp.expect(true, 'window closed after 24h');
update public.inbox_conversations set last_inbound_at = now() - interval '23 hours 59 minutes' where id=(select id from ctx);
select pg_temp.expect((select (public.begin_inbox_reply((select id from ctx), 'edge ok', gen_random_uuid(), '11111111-1111-1111-1111-111111111111')->>'created')::boolean), 'window open just inside 24h');

-- 6. Outcome + early status replay + monotonic statuses
create temp table r2 as select public.begin_inbox_reply((select id from ctx), 'Second reply', gen_random_uuid(), :actor::uuid) as j;
select pg_temp.recv_status('st-early-delivered','wamid.OUT2','delivered');   -- before wamid is stored
select pg_temp.expect((select status from public.inbox_messages where id=(select (j->>'id')::uuid from r2))='sending', 'status before wamid does not match yet');
select public.record_inbox_reply_result((select (j->>'id')::uuid from r2), 'accepted', 'wamid.OUT2', null) from r2;
select pg_temp.expect((select status from public.inbox_messages where provider_message_id='wamid.OUT2')='delivered', 'early delivered status replayed on wamid store');
select pg_temp.recv_status('st-read','wamid.OUT2','read');
select pg_temp.expect((select status from public.inbox_messages where provider_message_id='wamid.OUT2')='read', 'read advances');
select pg_temp.recv_status('st-late-sent','wamid.OUT2','sent');
select pg_temp.expect((select status from public.inbox_messages where provider_message_id='wamid.OUT2')='read', 'late sent does not regress');
select pg_temp.recv_status('st-late-failed','wamid.OUT2','failed','[{"code":131047,"title":"Re-engagement"}]'::jsonb);
select pg_temp.expect((select status from public.inbox_messages where provider_message_id='wamid.OUT2')='read', 'late failed does not overwrite read');

create temp table r3 as select public.begin_inbox_reply((select id from ctx), 'Third reply', gen_random_uuid(), :actor::uuid) as j;
select public.record_inbox_reply_result((select (j->>'id')::uuid from r3), 'accepted', 'wamid.OUT3', null) from r3;
select pg_temp.recv_status('st3-failed','wamid.OUT3','failed','[{"code":131047,"title":"Re-engagement message"}]'::jsonb);
select pg_temp.expect((select status from public.inbox_messages where provider_message_id='wamid.OUT3')='failed', 'failed after sent marks failed');
select pg_temp.expect((select error_summary from public.inbox_messages where provider_message_id='wamid.OUT3')='131047 Re-engagement message', 'error summary stored');

create temp table r4 as select public.begin_inbox_reply((select id from ctx), 'Fourth', gen_random_uuid(), :actor::uuid) as j;
select public.record_inbox_reply_result((select (j->>'id')::uuid from r4), 'uncertain', null, 'transport (no HTTP status)') from r4;
select pg_temp.expect((select status from public.inbox_messages where id=(select (j->>'id')::uuid from r4))='uncertain', 'uncertain recorded without wamid');
create temp table r5 as select public.begin_inbox_reply((select id from ctx), 'Fifth', gen_random_uuid(), :actor::uuid) as j;
select public.record_inbox_reply_result((select (j->>'id')::uuid from r5), 'rejected', null, 'provider (400)') from r5;
select pg_temp.expect((select status from public.inbox_messages where id=(select (j->>'id')::uuid from r5))='failed', 'rejected maps to failed');
do $$ begin perform public.record_inbox_reply_result((select (j->>'id')::uuid from r5), 'accepted', 'wamid.NEW', null); raise exception 'should fail'; exception when others then if sqlerrm <> 'Reply outcome cannot be changed' then raise; end if; end $$;
select pg_temp.expect(true, 'cannot flip a rejected reply to accepted');

-- 7. Opt-out and sender hold (a STOP also creates a sender-wide hold)
select pg_temp.recv_stop('env-stop','wamid.STOP1','15551230002');
select pg_temp.expect((select count(*) from public.inbox_messages where body='STOP')=1, 'STOP shows in inbox');
update public.inbox_conversations set last_inbound_at = now();
do $$ begin perform public.begin_inbox_reply((select id from public.inbox_conversations where wa_id='15551230002'), 'bye', gen_random_uuid(), '11111111-1111-1111-1111-111111111111'); raise exception 'should fail'; exception when others then if sqlerrm <> 'opted_out' then raise; end if; end $$;
select pg_temp.expect(true, 'reply to opted-out customer blocked');
do $$ begin perform public.begin_inbox_reply((select id from ctx), 'hi', gen_random_uuid(), '11111111-1111-1111-1111-111111111111'); raise exception 'should fail'; exception when others then if sqlerrm <> 'sender_hold' then raise; end if; end $$;
select pg_temp.expect(true, 'sender hold blocks other replies');
update public.meta_sender_holds set released_at = now();
select pg_temp.expect((select (public.begin_inbox_reply((select id from ctx), 'hold released', gen_random_uuid(), '11111111-1111-1111-1111-111111111111')->>'created')::boolean), 'reply allowed after hold release');

-- 8. Robustness: malformed message must not break webhook receipt
select public.receive_meta_whatsapp_webhook(pg_temp.sha('env-bad'),'{"object":"x","entry":[]}'::jsonb,
  jsonb_build_array(jsonb_build_object('dedupe_key',pg_temp.sha('bad'),'kind','message','waba_id','W1','phone_number_id','P1','field','messages','needs_review',true,'payload','{"id":"x"}'::jsonb)),'[]'::jsonb);
select pg_temp.expect((select count(*) from public.meta_webhook_items where dedupe_key=pg_temp.sha('bad'))=1, 'malformed message still stored raw');

-- 9. Grants: authenticated cannot read inbox tables
set role authenticated;
do $$ begin perform 1 from public.inbox_messages limit 1; raise exception 'should fail'; exception when insufficient_privilege then null; end $$;
reset role;
set role service_role;
select pg_temp.expect((select count(*) from public.inbox_conversations) >= 2, 'service_role can read');
reset role;
\echo ALL CHECKS PASSED
