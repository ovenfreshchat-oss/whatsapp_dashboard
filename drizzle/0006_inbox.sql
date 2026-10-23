-- WhatsApp inbox: conversations, messages, and free-text replies.
-- Apply after 0001_meta_webhook_inbox.sql. Safe to rerun.
--
-- Inbound messages and delivery statuses are projected from meta_webhook_items by
-- triggers, so the existing receive_meta_whatsapp_webhook function is unchanged.
-- The projection never fails webhook receipt: an error is logged as a warning and
-- the raw webhook item is still stored.

create extension if not exists pgcrypto;

create table if not exists public.inbox_conversations (
  id uuid primary key default gen_random_uuid(),
  waba_id text not null,
  phone_number_id text not null,
  wa_id text not null check (length(trim(wa_id)) > 0),
  profile_name text check (profile_name is null or length(profile_name) <= 200),
  last_inbound_at timestamptz,
  last_message_at timestamptz not null default now(),
  last_message_preview text,
  unread_count integer not null default 0 check (unread_count >= 0),
  created_at timestamptz not null default now(),
  unique (waba_id, phone_number_id, wa_id)
);

create index if not exists inbox_conversations_recent_idx
  on public.inbox_conversations (waba_id, phone_number_id, last_message_at desc);

create table if not exists public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.inbox_conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  provider_message_id text unique,
  -- Webhook dedupe key for inbound messages; makes projection idempotent.
  source_item_key text unique check (source_item_key is null or source_item_key ~ '^[0-9a-f]{64}$'),
  message_type text not null default 'text',
  body text check (body is null or length(body) <= 4096),
  status text not null default 'received'
    check (status in ('received', 'sending', 'sent', 'delivered', 'read', 'failed', 'uncertain')),
  error_summary text check (error_summary is null or length(error_summary) <= 500),
  -- Client-generated idempotency token for outbound replies.
  client_token uuid,
  sent_by uuid references auth.users(id),
  event_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, client_token)
);

create index if not exists inbox_messages_thread_idx
  on public.inbox_messages (conversation_id, event_at, id);

create or replace function public.inbox_touch_updated_at()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists inbox_messages_updated_at_trigger on public.inbox_messages;
create trigger inbox_messages_updated_at_trigger
before update on public.inbox_messages
for each row execute function public.inbox_touch_updated_at();

-- Human-readable text for any WhatsApp inbound message type.
create or replace function public.inbox_message_body(p_message jsonb)
returns text language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  v_type text := coalesce(p_message->>'type', 'unknown');
  v_text text;
begin
  v_text := case v_type
    when 'text' then p_message->'text'->>'body'
    when 'button' then p_message->'button'->>'text'
    when 'interactive' then coalesce(
      p_message->'interactive'->'button_reply'->>'title',
      p_message->'interactive'->'list_reply'->>'title')
    when 'reaction' then case when nullif(p_message->'reaction'->>'emoji', '') is null
      then '[Reaction removed]' else '[Reaction] ' || (p_message->'reaction'->>'emoji') end
    when 'image' then coalesce(nullif(p_message->'image'->>'caption', ''), '[Image]')
    when 'video' then coalesce(nullif(p_message->'video'->>'caption', ''), '[Video]')
    when 'document' then coalesce(nullif(p_message->'document'->>'caption', ''),
      '[Document' || coalesce(': ' || (p_message->'document'->>'filename'), '') || ']')
    when 'audio' then '[Voice or audio message]'
    when 'sticker' then '[Sticker]'
    when 'location' then '[Location' || coalesce(': ' || (p_message->'location'->>'name'), '') || ']'
    when 'contacts' then '[Contact card]'
    when 'order' then '[Order]'
    else null
  end;
  if v_text is null or length(trim(v_text)) = 0 then
    v_text := '[' || v_type || ' message]';
  end if;
  return left(v_text, 4096);
end;
$$;

-- Project one stored inbound message into the inbox. Idempotent per webhook item.
create or replace function public.project_inbox_message_item(p_item public.meta_webhook_items)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_from text := nullif(trim(coalesce(p_item.payload->>'from', '')), '');
  v_name text;
  v_event timestamptz := coalesce(p_item.event_timestamp, p_item.received_at);
  v_body text;
  v_conversation uuid;
  v_inserted integer;
begin
  if p_item.kind <> 'message' or v_from is null or p_item.phone_number_id is null then
    return;
  end if;

  select left(nullif(trim(c->'profile'->>'name'), ''), 200) into v_name
  from public.meta_webhook_envelopes e,
       jsonb_array_elements(case when jsonb_typeof(e.raw_payload->'entry') = 'array'
                                 then e.raw_payload->'entry' else '[]'::jsonb end) entry,
       jsonb_array_elements(case when jsonb_typeof(entry->'changes') = 'array'
                                 then entry->'changes' else '[]'::jsonb end) change,
       jsonb_array_elements(case when jsonb_typeof(change->'value'->'contacts') = 'array'
                                 then change->'value'->'contacts' else '[]'::jsonb end) c
  where e.id = p_item.envelope_id and c->>'wa_id' = v_from
  limit 1;

  v_body := public.inbox_message_body(p_item.payload);

  insert into public.inbox_conversations (
    waba_id, phone_number_id, wa_id, profile_name, last_message_at
  ) values (p_item.waba_id, p_item.phone_number_id, v_from, v_name, v_event)
  on conflict (waba_id, phone_number_id, wa_id) do update
    set profile_name = coalesce(excluded.profile_name, public.inbox_conversations.profile_name)
  returning id into v_conversation;

  insert into public.inbox_messages (
    conversation_id, direction, provider_message_id, source_item_key,
    message_type, body, status, event_at
  ) values (
    v_conversation, 'inbound', p_item.provider_message_id, p_item.dedupe_key,
    coalesce(p_item.payload->>'type', 'unknown'), v_body, 'received', v_event
  ) on conflict do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    update public.inbox_conversations
    set last_inbound_at = greatest(coalesce(last_inbound_at, '-infinity'::timestamptz), v_event),
        last_message_preview = case when v_event >= last_message_at
                                    then left(v_body, 120) else last_message_preview end,
        last_message_at = greatest(last_message_at, v_event),
        unread_count = unread_count + 1
    where id = v_conversation;
  end if;
end;
$$;

-- Delivery status for an outbound reply. Statuses only move forward; a late
-- "failed" never overwrites a delivered or read message.
create or replace function public.project_inbox_status(
  p_wamid text,
  p_status text,
  p_error_summary text
) returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_wamid is null or p_status not in ('sent', 'delivered', 'read', 'failed') then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_wamid, 0));

  update public.inbox_messages
  set status = case
        when status = 'failed' then status
        when p_status = 'failed' then case when status in ('sending', 'uncertain', 'sent')
                                           then 'failed' else status end
        when case p_status when 'read' then 3 when 'delivered' then 2 else 1 end
           > case status when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 else 0 end
          then p_status
        else status
      end,
      error_summary = case
        when p_status = 'failed' and status in ('sending', 'uncertain', 'sent')
          then left(coalesce(nullif(p_error_summary, ''), 'Delivery failed'), 500)
        else error_summary
      end
  where provider_message_id = p_wamid and direction = 'outbound';
end;
$$;

create or replace function public.project_inbox_webhook_item()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_error jsonb;
begin
  begin
    if new.kind = 'message' then
      perform public.project_inbox_message_item(new);
    elsif new.kind = 'status' then
      v_error := new.payload->'errors'->0;
      perform public.project_inbox_status(
        new.provider_message_id, new.provider_status,
        case when v_error is null then null
             else trim(coalesce(v_error->>'code', '') || ' ' || coalesce(v_error->>'title', '')) end
      );
    end if;
  exception when others then
    -- Never block webhook receipt on inbox projection.
    raise warning 'Inbox projection failed (%)', sqlstate;
  end;
  return new;
end;
$$;

drop trigger if exists project_inbox_webhook_item_trigger on public.meta_webhook_items;
create trigger project_inbox_webhook_item_trigger
after insert on public.meta_webhook_items
for each row execute function public.project_inbox_webhook_item();

-- A status can arrive before the reply's wamid is stored. Replay stored statuses.
create or replace function public.reconcile_inbox_message_status()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  event_record record;
begin
  if new.provider_message_id is null or new.direction <> 'outbound' then return new; end if;
  if tg_op = 'UPDATE' and new.provider_message_id is not distinct from old.provider_message_id then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.provider_message_id, 0));
  for event_record in
    select provider_message_id, provider_status,
           trim(coalesce(payload->'errors'->0->>'code', '') || ' ' ||
                coalesce(payload->'errors'->0->>'title', '')) as error_summary
    from public.meta_webhook_items
    where kind = 'status' and provider_message_id = new.provider_message_id
    order by coalesce(event_timestamp, received_at), received_at, id
  loop
    perform public.project_inbox_status(
      event_record.provider_message_id, event_record.provider_status, event_record.error_summary);
  end loop;
  return new;
end;
$$;

drop trigger if exists reconcile_inbox_message_status_trigger on public.inbox_messages;
create trigger reconcile_inbox_message_status_trigger
after insert or update of provider_message_id on public.inbox_messages
for each row execute function public.reconcile_inbox_message_status();

-- Reserve an outbound reply. The 24-hour window, recipient opt-out, and sender
-- hold are enforced here, under the conversation row lock, so no caller can skip them.
-- A repeated client_token returns the original row with created = false.
create or replace function public.begin_inbox_reply(
  p_conversation_id uuid,
  p_body text,
  p_client_token uuid,
  p_actor_user_id uuid
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_conversation public.inbox_conversations;
  v_existing public.inbox_messages;
  v_message public.inbox_messages;
  v_body text := trim(coalesce(p_body, ''));
begin
  if p_client_token is null or p_actor_user_id is null
     or length(v_body) not between 1 and 4096 then
    raise exception 'invalid_reply';
  end if;

  select * into v_conversation from public.inbox_conversations
  where id = p_conversation_id for update;
  if v_conversation.id is null then raise exception 'conversation_missing'; end if;

  select * into v_existing from public.inbox_messages
  where conversation_id = p_conversation_id and client_token = p_client_token;
  if v_existing.id is not null then
    return jsonb_build_object('id', v_existing.id, 'created', false,
                              'status', v_existing.status, 'wa_id', v_conversation.wa_id);
  end if;

  if v_conversation.wa_id !~ '^[1-9][0-9]{7,14}$' then raise exception 'invalid_recipient'; end if;
  if v_conversation.last_inbound_at is null
     or v_conversation.last_inbound_at < now() - interval '24 hours' then
    raise exception 'window_closed';
  end if;
  if exists (
    select 1 from public.meta_opt_outs
    where waba_id = v_conversation.waba_id and phone_number_id = v_conversation.phone_number_id
      and identity_type = 'whatsapp_from' and identity_value = v_conversation.wa_id
  ) then raise exception 'opted_out'; end if;
  if exists (
    select 1 from public.meta_sender_holds
    where waba_id = v_conversation.waba_id and phone_number_id = v_conversation.phone_number_id
      and released_at is null
  ) then raise exception 'sender_hold'; end if;

  insert into public.inbox_messages (
    conversation_id, direction, message_type, body, status, client_token, sent_by, event_at
  ) values (
    p_conversation_id, 'outbound', 'text', v_body, 'sending', p_client_token, p_actor_user_id, now()
  ) returning * into v_message;

  update public.inbox_conversations
  set last_message_at = greatest(last_message_at, v_message.event_at),
      last_message_preview = left('You: ' || v_body, 120)
  where id = p_conversation_id;

  return jsonb_build_object('id', v_message.id, 'created', true,
                            'status', v_message.status, 'wa_id', v_conversation.wa_id);
end;
$$;

-- Record Meta's outcome for a reserved reply. Accepted means Meta queued it, not delivered.
create or replace function public.record_inbox_reply_result(
  p_id uuid,
  p_state text,
  p_wamid text,
  p_error_summary text
) returns public.inbox_messages language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_result public.inbox_messages;
  v_status text;
begin
  if p_state not in ('accepted', 'rejected', 'uncertain')
     or (p_state = 'accepted' and nullif(p_wamid, '') is null)
     or (p_state <> 'accepted' and p_wamid is not null)
     or length(coalesce(p_error_summary, '')) > 500 then
    raise exception 'Invalid reply outcome';
  end if;
  v_status := case p_state when 'accepted' then 'sent' when 'rejected' then 'failed' else 'uncertain' end;

  if p_wamid is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  end if;

  update public.inbox_messages
  set status = v_status,
      provider_message_id = coalesce(p_wamid, provider_message_id),
      error_summary = p_error_summary
  where id = p_id and direction = 'outbound' and status in ('sending', 'uncertain')
  returning * into v_result;
  if v_result.id is not null then return v_result; end if;

  select * into v_result from public.inbox_messages where id = p_id and direction = 'outbound';
  if v_result.id is null then raise exception 'Reply does not exist'; end if;
  if v_result.provider_message_id is not distinct from p_wamid or p_state <> 'accepted' then
    return v_result;
  end if;
  raise exception 'Reply outcome cannot be changed';
end;
$$;

-- Backfill messages already stored by the webhook. Runs only on an empty inbox.
do $$
declare
  item public.meta_webhook_items;
begin
  if exists (select 1 from public.inbox_messages) then return; end if;
  for item in
    select * from public.meta_webhook_items
    where kind = 'message'
    order by coalesce(event_timestamp, received_at), received_at, id
  loop
    perform public.project_inbox_message_item(item);
  end loop;
end;
$$;

alter table public.inbox_conversations enable row level security;
alter table public.inbox_messages enable row level security;

revoke all on public.inbox_conversations, public.inbox_messages from public, anon, authenticated;
grant select on public.inbox_conversations, public.inbox_messages to service_role;
grant update (unread_count) on public.inbox_conversations to service_role;

revoke all on function public.inbox_touch_updated_at() from public, anon, authenticated;
revoke all on function public.inbox_message_body(jsonb) from public, anon, authenticated;
revoke all on function public.project_inbox_message_item(public.meta_webhook_items)
  from public, anon, authenticated;
revoke all on function public.project_inbox_status(text, text, text) from public, anon, authenticated;
revoke all on function public.project_inbox_webhook_item() from public, anon, authenticated;
revoke all on function public.reconcile_inbox_message_status() from public, anon, authenticated;
revoke all on function public.begin_inbox_reply(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_inbox_reply_result(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_inbox_reply(uuid, text, uuid, uuid) to service_role;
grant execute on function public.record_inbox_reply_result(uuid, text, text, text) to service_role;
