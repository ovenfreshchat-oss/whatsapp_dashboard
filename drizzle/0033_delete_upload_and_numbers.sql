-- Delete an upload (hides the list; its contacts and all campaign history are kept) and remove one number
-- from an upload. Apply after 0031 (archived_at). Safe to rerun.
-- Contacts are shared across uploads and referenced by campaigns and delivery records, so a number is only
-- taken out of THIS list, never deleted from the database.

create or replace function public.archive_import_batch(p_batch_id uuid)
returns text language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_batch_id is null then raise exception 'Invalid request'; end if;
  if not exists (select 1 from public.contact_import_batches where id = p_batch_id and archived_at is null) then
    return 'not_found';
  end if;
  -- A campaign that is scheduled, running or paused still sends to this list.
  if exists (select 1 from public.whatsapp_campaigns
             where import_batch_id = p_batch_id and state in ('scheduled', 'running', 'paused')) then
    return 'in_use';
  end if;
  update public.contact_import_batches set archived_at = now() where id = p_batch_id;
  return 'ok';
end;
$$;

create or replace function public.remove_contact_from_batch(p_batch_id uuid, p_contact_id uuid)
returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_batch_id is null or p_contact_id is null then raise exception 'Invalid request'; end if;
  delete from public.contact_batch_members where batch_id = p_batch_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.archive_import_batch(uuid) from public, anon, authenticated;
revoke all on function public.remove_contact_from_batch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.archive_import_batch(uuid) to service_role;
grant execute on function public.remove_contact_from_batch(uuid, uuid) to service_role;
