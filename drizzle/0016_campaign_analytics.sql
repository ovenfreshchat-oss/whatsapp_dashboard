-- Per-campaign analytics: funnel, failure reasons, replies, opt-outs, hourly timeline and
-- webhook coverage. Read-only; safe to rerun. Apply after 0003.
create or replace function public.whatsapp_campaign_analytics(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  campaign public.whatsapp_campaigns;
  started timestamptz;
  result jsonb;
begin
  select * into campaign from public.whatsapp_campaigns where id = p_campaign_id;
  if not found then return null; end if;

  select min(finished_at) into started
  from public.whatsapp_campaign_recipients
  where campaign_id = p_campaign_id and state = 'accepted';

  with r as (
    select id, state, wamid, delivery_status, delivery_conflict, finished_at, last_status_at,
           error_summary, recipient_e164
    from public.whatsapp_campaign_recipients where campaign_id = p_campaign_id
  ),
  ev as (
    select i.provider_message_id as wamid, i.provider_status as status, i.event_timestamp, i.payload
    from public.meta_webhook_items i
    where i.kind = 'status' and i.waba_id = campaign.waba_id
      and i.phone_number_id = campaign.phone_number_id
      and i.provider_message_id in (select wamid from r where wamid is not null)
  ),
  latency as (
    select extract(epoch from (min(ev.event_timestamp) - r.finished_at)) as seconds, ev.status
    from r join ev on ev.wamid = r.wamid and ev.status in ('delivered', 'read')
    where r.finished_at is not null and ev.event_timestamp is not null
    group by r.id, r.finished_at, ev.status
  ),
  failures as (
    select coalesce(ev.payload->'errors'->0->>'code', '?') as code,
           coalesce(ev.payload->'errors'->0->>'title', ev.payload->'errors'->0->>'message', 'Unknown') as title,
           count(distinct ev.wamid) as total
    from ev where ev.status = 'failed' group by 1, 2
  ),
  rejections as (
    select left(coalesce(error_summary, 'Unknown'), 140) as reason, count(*) as total
    from r where state = 'rejected' group by 1
  ),
  inbound as (
    select i.payload->>'from' as sender, i.event_timestamp
    from public.meta_webhook_items i
    where i.kind = 'message' and i.waba_id = campaign.waba_id
      and i.phone_number_id = campaign.phone_number_id
      and started is not null and i.event_timestamp >= started
      and i.payload->>'from' in (select ltrim(recipient_e164, '+') from r)
  ),
  stops as (
    select count(*) as total from public.meta_opt_outs o
    where o.waba_id = campaign.waba_id and o.phone_number_id = campaign.phone_number_id
      and started is not null and o.created_at >= started
      and o.identity_value in (select ltrim(recipient_e164, '+') from r)
  ),
  hourly as (
    select date_trunc('hour', finished_at) as hour,
           count(*) as accepted,
           count(*) filter (where delivery_status in ('delivered', 'read')) as delivered,
           count(*) filter (where delivery_status = 'read') as read
    from r where state = 'accepted' and finished_at is not null group by 1
  )
  select jsonb_build_object(
    'audience', (select count(*) from r),
    'attempted', (select count(*) from r where state in ('accepted', 'rejected', 'uncertain')),
    'accepted', (select count(*) from r where state = 'accepted'),
    'rejected', (select count(*) from r where state = 'rejected'),
    'uncertain', (select count(*) from r where state = 'uncertain'),
    'suppressed', (select count(*) from r where state = 'suppressed'),
    'canceled', (select count(*) from r where state = 'canceled'),
    'pending', (select count(*) from r where state in ('pending', 'in_flight')),
    'sent', (select count(*) from r where delivery_status in ('sent', 'delivered', 'read')),
    'delivered', (select count(*) from r where delivery_status in ('delivered', 'read')),
    'read', (select count(*) from r where delivery_status = 'read'),
    'failed', (select count(*) from r where delivery_status = 'failed'),
    'no_status', (select count(*) from r where state = 'accepted' and delivery_status is null),
    'conflicts', (select count(*) from r where delivery_conflict),
    'first_accepted_at', started,
    'last_accepted_at', (select max(finished_at) from r where state = 'accepted'),
    'last_status_at', (select max(last_status_at) from r),
    'median_delivered_seconds', (select percentile_cont(0.5) within group (order by seconds) from latency where status = 'delivered'),
    'median_read_seconds', (select percentile_cont(0.5) within group (order by seconds) from latency where status = 'read'),
    'failure_reasons', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'title', title, 'total', total) order by total desc) from failures), '[]'::jsonb),
    'rejection_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'total', total) order by total desc) from rejections), '[]'::jsonb),
    'replies', (select count(*) from inbound),
    'repliers', (select count(distinct sender) from inbound),
    'opt_outs', (select total from stops),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object('hour', hour, 'accepted', accepted, 'delivered', delivered, 'read', read) order by hour) from hourly), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.whatsapp_campaign_analytics(uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_campaign_analytics(uuid) to service_role;
