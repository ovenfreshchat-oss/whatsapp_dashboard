-- Before a campaign is sent: how many people will get it and how many are excluded, and why.
-- Safe to rerun. Read only: it changes nothing and never deletes or hides a contact.
create or replace function public.campaign_audience_review(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  c public.whatsapp_campaigns;
  v_result jsonb;
begin
  select * into c from public.whatsapp_campaigns where id = p_campaign_id;
  if not found then raise exception 'Campaign not found'; end if;

  with pool as (
    select ct.id, ct.phone_e164
    from public.contacts ct
    where ct.phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
      and (c.audience_source = 'all_eligible'
           or exists (select 1 from public.contact_batch_members m
                      where m.batch_id = c.import_batch_id and m.contact_id = ct.id))
  ), judged as (
    select p.id, s.status,
           public.can_send_whatsapp_marketing(p.id, c.waba_id, c.phone_number_id) as sendable,
           exists (select 1 from public.whatsapp_campaign_recipients r
                   where r.campaign_id = c.id and r.contact_id = p.id) as in_campaign,
           exists (select 1 from public.whatsapp_campaign_recipients r
                   where r.campaign_id = c.id and r.contact_id = p.id and r.state = 'pending') as pending_send
    from pool p
    cross join lateral public.contact_delivery_state(p.phone_e164) s
  )
  select jsonb_build_object(
    'pool', count(*),
    'eligible', count(*) filter (where sendable),
    'excluded', count(*) filter (where not sendable),
    'opt_out', count(*) filter (where not sendable and status = 'opt_out'),
    'do_not_send', count(*) filter (where not sendable and status = 'do_not_send'),
    'other', count(*) filter (where not sendable and status not in ('opt_out', 'do_not_send')),
    'at_risk_eligible', count(*) filter (where sendable and status = 'at_risk'),
    'in_campaign', count(*) filter (where in_campaign),
    'will_skip_at_send', count(*) filter (where pending_send and not sendable))
  into v_result from judged;
  return v_result;
end;
$$;

revoke all on function public.campaign_audience_review(uuid) from public, anon, authenticated;
grant execute on function public.campaign_audience_review(uuid) to service_role;
