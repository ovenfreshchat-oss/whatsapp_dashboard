-- Do-not-contact list. Any phone number in this table with released_at IS NULL is removed
-- from campaign audiences when a draft is created AND is rechecked immediately before every
-- send (the worker's send gate calls can_send_whatsapp_marketing), so a number added after a
-- campaign was scheduled is still skipped and marked 'suppressed'.
-- Numbers need not exist in public.contacts. Apply after 0008/0009. Safe to rerun.

create table if not exists public.opt_out_numbers (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  source text not null check (length(source) between 1 and 200),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  released_at timestamptz check (released_at is null or released_at >= created_at),
  released_by uuid references auth.users(id)
);

alter table public.opt_out_numbers enable row level security;
revoke all on public.opt_out_numbers from public, anon, authenticated;
grant select on public.opt_out_numbers to service_role;

-- Bulk add. Re-adding a released number re-activates it. Returns counts.
create or replace function public.add_opt_out_numbers(
  p_phones text[], p_source text, p_actor_user_id uuid
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_phones text[];
  v_already integer;
  v_reactivated integer;
begin
  if p_actor_user_id is null
     or p_source is null or length(trim(p_source)) not between 1 and 200
     or p_phones is null or cardinality(p_phones) not between 1 and 5000
     or exists (select 1 from unnest(p_phones) p where p is null or p !~ '^\+[1-9][0-9]{7,14}$') then
    raise exception 'Invalid opt-out numbers';
  end if;
  select array_agg(distinct p) into v_phones from unnest(p_phones) p;
  select count(*) into v_already from public.opt_out_numbers
    where phone_e164 = any(v_phones) and released_at is null;
  select count(*) into v_reactivated from public.opt_out_numbers
    where phone_e164 = any(v_phones) and released_at is not null;

  insert into public.opt_out_numbers (phone_e164, source, created_by)
  select p, trim(p_source), p_actor_user_id from unnest(v_phones) p
  on conflict (phone_e164) do update
    set released_at = null, released_by = null, created_at = now(),
        source = excluded.source, created_by = excluded.created_by
    where public.opt_out_numbers.released_at is not null;

  return jsonb_build_object(
    'added', cardinality(v_phones) - v_already - v_reactivated,
    'reactivated', v_reactivated,
    'already_listed', v_already);
end;
$$;

-- Soft remove: keeps who/when, and the number can be listed again later.
create or replace function public.release_opt_out_number(
  p_id uuid, p_actor_user_id uuid
) returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_id is null or p_actor_user_id is null then
    raise exception 'Invalid opt-out release';
  end if;
  update public.opt_out_numbers
  set released_at = now(), released_by = p_actor_user_id
  where id = p_id and released_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.add_opt_out_numbers(text[], text, uuid) from public, anon, authenticated;
revoke all on function public.release_opt_out_number(uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_opt_out_numbers(text[], text, uuid) to service_role;
grant execute on function public.release_opt_out_number(uuid, uuid) to service_role;

-- 0008's eligibility function plus the new list. Used at draft time and at send time.
create or replace function public.can_send_whatsapp_marketing(
  p_contact_id uuid, p_waba_id text, p_phone_number_id text
) returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    p_waba_id is not null and length(p_waba_id) > 0
    and p_phone_number_id is not null and length(p_phone_number_id) > 0
    and exists (
      select 1 from public.contacts c
      where c.id = p_contact_id
        and not exists (
          select 1 from public.opt_out_numbers n
          where n.phone_e164 = c.phone_e164 and n.released_at is null)
        and not exists (
          select 1 from public.contact_marketing_suppressions s
          where s.phone_e164 = c.phone_e164 and s.released_at is null)
        and not exists (
          select 1 from public.meta_opt_outs o
          where o.waba_id = p_waba_id and o.phone_number_id = p_phone_number_id
            and o.identity_type = 'whatsapp_from'
            and o.identity_value in (c.phone_e164, substring(c.phone_e164 from 2)))
    ), false);
$$;
