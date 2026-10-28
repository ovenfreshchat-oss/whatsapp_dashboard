-- Manual baselines for the dashboard totals. Messages sent before this database was connected
-- (or outside the dashboard) are not in the database, so an admin records the difference
-- between Meta's real total and what the database counted. The dashboard shows
-- database count + adjustment, so new sends keep adding on top. Safe to rerun.
-- Apply after 0021. Written only by the server with the service key.

create table if not exists public.dashboard_metric_adjustments (
  metric text primary key check (metric in ('messages_sent', 'messages_delivered', 'marketing', 'utility', 'authentication')),
  value integer not null default 0 check (value >= 0 and value <= 100000000),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.dashboard_metric_adjustments enable row level security;
revoke all on public.dashboard_metric_adjustments from public, anon, authenticated;
grant select, insert, update, delete on public.dashboard_metric_adjustments to service_role;
