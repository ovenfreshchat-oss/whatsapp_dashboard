-- Inbox retention: keep 3 months of chat history, then clean up automatically.
-- Apply after 0006 and 0001. Safe to rerun.
--
-- purge_inbox_history(p_before) is called daily by the Vercel cron route /api/cron/inbox-retention.
--   * Deletes inbox messages older than the cutoff.
--   * KEEPS every conversation, so the customer's number and name stay in the Chats list; a
--     conversation with no messages left opens as an empty chat window.
--   * Empties the preview and unread badge of conversations left with no messages.
--   * Redacts old webhook bodies (message text) via redact_meta_webhook_payloads; hashes, opt-out
--     evidence and unresolved review items are kept.
create or replace function public.purge_inbox_history(p_before timestamptz)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_messages integer;
  v_emptied integer;
  v_redacted jsonb;
begin
  if p_before is null or p_before >= now() - interval '30 days' then
    raise exception 'A cutoff at least 30 days in the past is required';
  end if;

  delete from public.inbox_messages where event_at < p_before;
  get diagnostics v_messages = row_count;

  update public.inbox_conversations as c
  set last_message_preview = null, unread_count = 0
  where (c.last_message_preview is not null or c.unread_count > 0)
    and not exists (select 1 from public.inbox_messages m where m.conversation_id = c.id);
  get diagnostics v_emptied = row_count;

  v_redacted := public.redact_meta_webhook_payloads(p_before);

  return jsonb_build_object('messages_deleted', v_messages,
                            'conversations_emptied', v_emptied) || v_redacted;
end;
$$;

revoke all on function public.purge_inbox_history(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_inbox_history(timestamptz) to service_role;
