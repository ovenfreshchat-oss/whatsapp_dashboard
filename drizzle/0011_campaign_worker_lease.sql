-- Support for running the campaign sender as a Vercel Workflow instead of a standalone process.
-- 1) A single lease so only one run sends at a time (the worker README requires one sender).
-- 2) A status RPC the workflow uses to decide whether to keep going, and how long to sleep.
-- Apply after 0010. Safe to rerun.

create table if not exists public.campaign_worker_lease (
  lease_key text primary key check (lease_key = 'whatsapp'),
  holder text not null check (length(holder) between 1 and 100),
  expires_at timestamptz not null
);
alter table public.campaign_worker_lease enable row level security;
revoke all on public.campaign_worker_lease from public, anon, authenticated;
grant select on public.campaign_worker_lease to service_role;

-- Take the lease, or renew it when the caller already holds it. Returns false when another
-- holder's lease is still valid.
create or replace function public.acquire_campaign_worker_lease(
  p_holder text, p_ttl_seconds integer
) returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_holder is null or length(p_holder) not between 1 and 100
     or p_ttl_seconds is null or p_ttl_seconds not between 10 and 900 then
    raise exception 'Invalid worker lease request';
  end if;
  insert into public.campaign_worker_lease (lease_key, holder, expires_at)
  values ('whatsapp', p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (lease_key) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where public.campaign_worker_lease.holder = p_holder
       or public.campaign_worker_lease.expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create or replace function public.release_campaign_worker_lease(p_holder text)
returns void language sql security definer
set search_path = public, pg_temp
as $$
  delete from public.campaign_worker_lease where lease_key = 'whatsapp' and holder = p_holder;
$$;

create or replace function public.campaign_worker_status()
returns jsonb language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'running_pending', exists (
      select 1 from public.whatsapp_campaign_recipients r
      join public.whatsapp_campaigns c on c.id = r.campaign_id
      where r.state = 'pending' and c.state = 'running'),
    'in_flight', exists (
      select 1 from public.whatsapp_campaign_recipients where state = 'in_flight'),
    'next_scheduled_at', (
      select min(scheduled_for) from public.whatsapp_campaigns where state = 'scheduled')
  );
$$;

revoke all on function public.acquire_campaign_worker_lease(text, integer) from public, anon, authenticated;
revoke all on function public.release_campaign_worker_lease(text) from public, anon, authenticated;
revoke all on function public.campaign_worker_status() from public, anon, authenticated;
grant execute on function public.acquire_campaign_worker_lease(text, integer) to service_role;
grant execute on function public.release_campaign_worker_lease(text) to service_role;
grant execute on function public.campaign_worker_status() to service_role;
