-- Same-name contact lists. A list is an import batch named after its file.
-- "Replace" archives the old list (hidden everywhere, rows and campaign history kept);
-- "Add to existing" copies the new file's contacts into the old list and archives the new batch.
-- Apply after 0030. Safe to rerun.

alter table public.contact_import_batches add column if not exists archived_at timestamptz;

create index if not exists contact_import_batches_name_idx
  on public.contact_import_batches (lower(btrim(file_name)))
  where archived_at is null;

create or replace function public.resolve_duplicate_import_list(
  p_old_batch_id uuid, p_new_batch_id uuid, p_mode text
) returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer := 0;
begin
  if p_mode not in ('merge', 'replace') or p_old_batch_id is null or p_new_batch_id is null
     or p_old_batch_id = p_new_batch_id then
    raise exception 'Invalid request';
  end if;
  if not exists (select 1 from public.contact_import_batches where id = p_old_batch_id and archived_at is null)
     or not exists (select 1 from public.contact_import_batches where id = p_new_batch_id) then
    raise exception 'Import batch not found';
  end if;
  if p_mode = 'merge' then
    insert into public.contact_batch_members (batch_id, contact_id)
    select p_old_batch_id, m.contact_id from public.contact_batch_members m where m.batch_id = p_new_batch_id
    on conflict do nothing;
    get diagnostics v_count = row_count;
    update public.contact_import_batches set archived_at = now() where id = p_new_batch_id;
  else
    update public.contact_import_batches set archived_at = now() where id = p_old_batch_id;
  end if;
  return v_count;
end;
$$;
revoke all on function public.resolve_duplicate_import_list(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_duplicate_import_list(uuid, uuid, text) to service_role;
