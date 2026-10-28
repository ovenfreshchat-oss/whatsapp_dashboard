-- Make the dashboard totals match Meta. Run in the Supabase SQL editor AFTER applying 0022.
-- 1) Replace the five numbers in `meta` with Meta's real totals (WhatsApp Manager -> Insights,
--    or the output of `npm run check:meta`). Delete a row to leave that card unchanged.
-- 2) Run. It stores (Meta total - what the database counted) as the manual baseline, so new
--    sends keep adding on top. Totals lower than the database count are clamped to 0.
-- Counting rules match src/server/dashboard/metrics.ts exactly.

with meta(metric, total) as (values
  ('messages_sent',      0),
  ('messages_delivered', 0),
  ('marketing',          0),
  ('utility',            0),
  ('authentication',     0)
), db(metric, counted) as (
  select 'messages_sent'::text,
    (select count(*) from public.whatsapp_campaign_recipients where state = 'accepted')
    + (select count(*) from public.inbox_messages where direction = 'outbound' and status in ('sent', 'delivered', 'read'))
  union all select 'messages_delivered',
    (select count(*) from public.whatsapp_campaign_recipients where delivery_status in ('delivered', 'read'))
    + (select count(*) from public.inbox_messages where direction = 'outbound' and status in ('delivered', 'read'))
  union all select 'marketing',
    (select count(*) from public.whatsapp_campaign_recipients where state = 'accepted')
  union all select 'utility', 0::bigint
  union all select 'authentication', 0::bigint
)
insert into public.dashboard_metric_adjustments (metric, value, updated_at)
select meta.metric, greatest(meta.total - db.counted, 0)::integer, now()
from meta join db using (metric)
on conflict (metric) do update set value = excluded.value, updated_at = excluded.updated_at;

-- Check the result (value = baseline added on top of the database count):
select metric, value, updated_at from public.dashboard_metric_adjustments order by metric;
