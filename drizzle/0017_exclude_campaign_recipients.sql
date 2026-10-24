-- Skip chosen numbers in a draft campaign (or put them back). Excluded recipients stay on the
-- campaign as 'canceled' with a marker, so they are visible and reversible, and audience_count
-- becomes the number that will actually be sent. Draft campaigns only. Safe to rerun.
create or replace function public.set_campaign_recipient_exclusions(
  p_campaign_id uuid,
  p_phones text[],
  p_restore boolean default false
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  campaign public.whatsapp_campaigns;
  v_changed integer;
  v_count integer;
begin
  select * into campaign from public.whatsapp_campaigns where id = p_campaign_id for update;
  if campaign.id is null then raise exception 'Campaign not found'; end if;
  if campaign.state <> 'draft' then
    raise exception 'Numbers can only be skipped before the campaign is scheduled';
  end if;

  if p_restore then
    update public.whatsapp_campaign_recipients
    set state = 'pending', finished_at = null, error_summary = null, updated_at = now()
    where campaign_id = p_campaign_id and state = 'canceled'
      and error_summary = 'Excluded before sending'
      and (p_phones is null or recipient_e164 = any(p_phones));
  else
    update public.whatsapp_campaign_recipients
    set state = 'canceled', finished_at = now(), error_summary = 'Excluded before sending',
        updated_at = now()
    where campaign_id = p_campaign_id and state = 'pending'
      and recipient_e164 = any(p_phones);
  end if;
  get diagnostics v_changed = row_count;

  select count(*) into v_count from public.whatsapp_campaign_recipients
  where campaign_id = p_campaign_id and state = 'pending';
  update public.whatsapp_campaigns set audience_count = v_count, updated_at = now()
  where id = p_campaign_id;
  return jsonb_build_object('changed', v_changed, 'audience_count', v_count);
end;
$$;
revoke all on function public.set_campaign_recipient_exclusions(uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.set_campaign_recipient_exclusions(uuid, text[], boolean) to service_role;
