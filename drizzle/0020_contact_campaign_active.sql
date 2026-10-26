-- Per-number on/off switch for campaigns. An inactive contact is left out of every new campaign
-- draft AND is rechecked right before each send (the send gate calls can_send_whatsapp_marketing),
-- so switching someone off also stops a campaign that is already scheduled. Switching them back on
-- puts them in the next campaign. Opt-outs (STOP replies, do-not-contact list) still always win.
-- Apply after 0010. Safe to rerun.

alter table public.contacts add column if not exists campaign_active boolean not null default true;

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
        and c.campaign_active
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

create or replace function public.set_contact_campaign_active(
  p_contact_id uuid, p_active boolean
) returns boolean language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_contact_id is null or p_active is null then raise exception 'Invalid request'; end if;
  update public.contacts set campaign_active = p_active, updated_at = now()
  where id = p_contact_id and campaign_active is distinct from p_active;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create or replace function public.set_batch_campaign_active(
  p_batch_id uuid, p_active boolean
) returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_batch_id is null or p_active is null then raise exception 'Invalid request'; end if;
  update public.contacts c set campaign_active = p_active, updated_at = now()
  where c.campaign_active is distinct from p_active
    and exists (select 1 from public.contact_batch_members m
                where m.batch_id = p_batch_id and m.contact_id = c.id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.set_contact_campaign_active(uuid, boolean) from public, anon, authenticated;
revoke all on function public.set_batch_campaign_active(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_contact_campaign_active(uuid, boolean) to service_role;
grant execute on function public.set_batch_campaign_active(uuid, boolean) to service_role;
