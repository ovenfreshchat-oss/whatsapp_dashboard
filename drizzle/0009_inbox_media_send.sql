-- Send photos and videos from the inbox. Apply after 0006_inbox.sql. Safe to rerun.
-- Adds media columns for outbound messages and extends begin_inbox_reply with a message type.
-- The 24-hour window, opt-out and sender-hold checks are unchanged.

alter table public.inbox_messages
  add column if not exists media_id text,
  add column if not exists media_mime text,
  add column if not exists media_name text;

-- inbox_messages.body is null for a media message sent without a caption.
drop function if exists public.begin_inbox_reply(uuid, text, uuid, uuid);

create or replace function public.begin_inbox_reply(
  p_conversation_id uuid,
  p_body text,
  p_client_token uuid,
  p_actor_user_id uuid,
  p_message_type text default 'text',
  p_media_id text default null,
  p_media_mime text default null,
  p_media_name text default null
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
     or p_message_type not in ('text', 'image', 'video')
     or (p_message_type = 'text' and (length(v_body) not between 1 and 4096 or p_media_id is not null))
     or (p_message_type <> 'text' and (length(v_body) > 1024 or nullif(p_media_id, '') is null
                                       or length(coalesce(p_media_name, '')) > 200
                                       or length(coalesce(p_media_mime, '')) > 100)) then
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
    conversation_id, direction, message_type, body, status, client_token, sent_by, event_at,
    media_id, media_mime, media_name
  ) values (
    p_conversation_id, 'outbound', p_message_type, nullif(v_body, ''), 'sending', p_client_token, p_actor_user_id, now(),
    nullif(p_media_id, ''), p_media_mime, p_media_name
  ) returning * into v_message;

  update public.inbox_conversations
  set last_message_at = greatest(last_message_at, v_message.event_at),
      last_message_preview = left('You: ' || case p_message_type
        when 'image' then '[Photo] ' when 'video' then '[Video] ' else '' end || v_body, 120)
  where id = p_conversation_id;

  return jsonb_build_object('id', v_message.id, 'created', true,
                            'status', v_message.status, 'wa_id', v_conversation.wa_id);
end;
$$;

revoke all on function public.begin_inbox_reply(uuid, text, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_inbox_reply(uuid, text, uuid, uuid, text, text, text, text)
  to service_role;
