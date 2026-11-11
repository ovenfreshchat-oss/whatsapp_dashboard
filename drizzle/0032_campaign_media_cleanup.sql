-- Removes a campaign's header image/video from storage once it is no longer needed.
-- Rule (completed or canceled campaigns only):
--   * no failed messages  -> due p_clean_days (default 1) after the campaign finished
--   * has failed messages -> due p_failed_days (default 4) after its last failure/retry activity
--   * with p_wait_for_retries (default true) a campaign with a retry still pending/in flight is never due,
--     because a retry sends the same header and would fail once the file is gone
--   * a file used by another campaign that is not also due is kept
-- The daily cron route /api/cron/campaign-media-cleanup deletes the files and calls mark_campaign_media_removed.
-- Apply after 0031. Safe to rerun.

alter table public.whatsapp_campaigns add column if not exists media_removed_at timestamptz;

create or replace function public.campaigns_with_expired_media(
  p_clean_days integer default 1,
  p_failed_days integer default 4,
  p_wait_for_retries boolean default true
) returns table (campaign_id uuid, media_url text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with activity as (
    select c.id, c.header_media_url, c.state,
      greatest(
        coalesce(c.completed_at, c.updated_at),
        coalesce((select max(f.failed_at) from public.contact_delivery_failures f where f.campaign_id = c.id), '-infinity'::timestamptz),
        coalesce((select max(r.updated_at) from public.campaign_message_retries r where r.campaign_id = c.id), '-infinity'::timestamptz)
      ) as last_activity,
      exists (select 1 from public.contact_delivery_failures f where f.campaign_id = c.id) as has_failed,
      exists (select 1 from public.campaign_message_retries r
              where r.campaign_id = c.id and r.state in ('pending', 'in_flight')) as retry_waiting
    from public.whatsapp_campaigns c
    where c.header_media_url is not null and c.media_removed_at is null
  ), due as (
    select a.* from activity a
    where a.state in ('completed', 'canceled')
      and not (p_wait_for_retries and a.retry_waiting)
      and a.last_activity <= now() - make_interval(days => case when a.has_failed then p_failed_days else p_clean_days end)
  )
  select d.id, d.header_media_url
  from due d
  where not exists (
    select 1 from activity o
    where o.header_media_url = d.header_media_url and o.id <> d.id and o.id not in (select id from due)
  );
$$;

-- After the file is deleted: hide it on every campaign that used it and forget its WhatsApp media IDs.
create or replace function public.mark_campaign_media_removed(p_media_url text)
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_media_url is null or length(p_media_url) = 0 then raise exception 'Invalid request'; end if;
  update public.whatsapp_campaigns set media_removed_at = now()
    where header_media_url = p_media_url and media_removed_at is null;
  get diagnostics v_count = row_count;
  delete from public.whatsapp_media_cache where source_url = p_media_url;
  return v_count;
end;
$$;

revoke all on function public.campaigns_with_expired_media(integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.mark_campaign_media_removed(text) from public, anon, authenticated;
grant execute on function public.campaigns_with_expired_media(integer, integer, boolean) to service_role;
grant execute on function public.mark_campaign_media_removed(text) to service_role;
