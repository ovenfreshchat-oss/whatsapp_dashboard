-- Fix: the first delivery status for a message crashed with
--   null value in column "delivery_conflict" violates not-null constraint
-- because (NULL = 'failed' AND ...) evaluates to NULL while delivery_status is still empty.
-- The failing trigger rolled back the whole webhook receipt, so Meta saw an error and the
-- status was never stored. The conflict flag is now always true/false. Safe to rerun.
create or replace function public.project_meta_test_send_status(
  p_waba_id text,
  p_phone_number_id text,
  p_wamid text,
  p_status text,
  p_event_at timestamptz
) returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_wamid is null or p_status not in ('sent', 'delivered', 'read', 'failed') then
    return;
  end if;

  -- Serialize projection with the wamid reconciliation trigger. Otherwise a
  -- concurrent webhook and send update can each miss the other's uncommitted row.
  perform pg_advisory_xact_lock(hashtextextended(p_wamid, 0));

  update public.meta_test_sends as send
  set state = case when send.state in ('prepared', 'in_flight', 'uncertain')
                   then 'accepted' else send.state end,
      delivery_conflict = coalesce(
        send.delivery_conflict
        or send.state = 'rejected'
        or (send.delivery_status = 'failed' and p_status <> 'failed')
        or (send.delivery_status in ('sent', 'delivered', 'read') and p_status = 'failed'),
        false),
      delivery_status = case
        when send.delivery_status is null then p_status
        when send.delivery_status = 'failed' or p_status = 'failed' then send.delivery_status
        when case p_status when 'read' then 3 when 'delivered' then 2 else 1 end
           > case send.delivery_status when 'read' then 3 when 'delivered' then 2 else 1 end
          then p_status
        else send.delivery_status
      end,
      last_status_at = greatest(coalesce(send.last_status_at, '-infinity'::timestamptz),
                                coalesce(p_event_at, now()))
  where send.wamid = p_wamid
    and send.waba_id = p_waba_id
    and send.phone_number_id = p_phone_number_id;
end;
$$;

create or replace function public.project_whatsapp_campaign_status(
  p_waba_id text,
  p_phone_number_id text,
  p_wamid text,
  p_status text,
  p_event_at timestamptz
) returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_wamid is null or p_status not in ('sent', 'delivered', 'read', 'failed') then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  update public.whatsapp_campaign_recipients as recipient
  set state = case when recipient.state in ('in_flight', 'uncertain')
                   then 'accepted' else recipient.state end,
      delivery_conflict = coalesce(
        recipient.delivery_conflict
        or recipient.state = 'rejected'
        or (recipient.delivery_status = 'failed' and p_status <> 'failed')
        or (recipient.delivery_status in ('sent', 'delivered', 'read') and p_status = 'failed'),
        false),
      delivery_status = case
        when recipient.delivery_status is null then p_status
        when recipient.delivery_status = 'failed' or p_status = 'failed'
          then recipient.delivery_status
        when case p_status when 'read' then 3 when 'delivered' then 2 else 1 end
           > case recipient.delivery_status when 'read' then 3
             when 'delivered' then 2 else 1 end then p_status
        else recipient.delivery_status
      end,
      last_status_at = greatest(coalesce(recipient.last_status_at, '-infinity'::timestamptz),
                                coalesce(p_event_at, now())),
      updated_at = now()
  from public.whatsapp_campaigns as campaign
  where recipient.campaign_id = campaign.id
    and recipient.wamid = p_wamid and campaign.waba_id = p_waba_id
    and campaign.phone_number_id = p_phone_number_id;
end;
$$;
