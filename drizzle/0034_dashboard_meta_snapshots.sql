-- Last good answer from Meta for each dashboard number, so the dashboard shows the last known value
-- (labelled with its time) when Meta cannot be reached, instead of dropping to "—" or another source.
-- Apply after 0033. Safe to rerun. Written only by the server with the service key.

create table if not exists public.dashboard_meta_snapshots (
  key text primary key check (length(key) between 1 and 200),
  value jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.dashboard_meta_snapshots enable row level security;
revoke all on public.dashboard_meta_snapshots from public, anon, authenticated;
grant select, insert, update, delete on public.dashboard_meta_snapshots to service_role;
