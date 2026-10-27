-- Remove a draft campaign that was never scheduled or sent. Only state = 'draft' can be deleted:
-- a draft has no send attempts, but its recipients and audit rows are removed with it.
-- Scheduled, running, paused, canceled and completed campaigns are history and cannot be deleted.
-- Apply after 0017. Safe to rerun.
create or replace function public.delete_draft_campaign(p_campaign_id uuid)
returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_state text;
begin
  if p_campaign_id is null then raise exception 'Invalid campaign'; end if;
  select state into v_state from public.whatsapp_campaigns where id = p_campaign_id for update;
  if v_state is null then return false; end if;
  if v_state <> 'draft' then
    raise exception 'Only a draft campaign can be deleted';
  end if;
  delete from public.whatsapp_campaign_send_attempts
    where recipient_id in (select id from public.whatsapp_campaign_recipients where campaign_id = p_campaign_id);
  delete from public.whatsapp_campaign_recipients where campaign_id = p_campaign_id;
  delete from public.whatsapp_campaign_audit where campaign_id = p_campaign_id;
  delete from public.whatsapp_campaigns where id = p_campaign_id;
  return true;
end;
$$;
revoke all on function public.delete_draft_campaign(uuid) from public, anon, authenticated;
grant execute on function public.delete_draft_campaign(uuid) to service_role;
