  -- Internal-use simplification: any saved phone number can receive campaigns.
  -- Apply after 0003/0005/0007. Safe to rerun.
  --
  -- Removed: the consent-event requirement and the sender-hold check.
  -- Kept: numbers that replied STOP (meta_opt_outs) or have an active suppression are still
  -- skipped, because messaging someone who opted out gets the WhatsApp number restricted.

  create table if not exists public.contact_batch_members (
    batch_id uuid not null references public.contact_import_batches(id),
    contact_id uuid not null references public.contacts(id),
    primary key (batch_id, contact_id)
  );
  alter table public.contact_batch_members enable row level security;
  revoke all on public.contact_batch_members from public, anon, authenticated;
  grant select, insert on public.contact_batch_members to service_role;

  create or replace function public.link_import_batch_contacts(
    p_batch_id uuid, p_actor_user_id uuid, p_phones text[]
  ) returns integer language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare v_count integer;
  begin
    if not exists (select 1 from public.contact_import_batches
                  where id = p_batch_id and actor_user_id = p_actor_user_id) then
      raise exception 'Import batch not found';
    end if;
    insert into public.contact_batch_members (batch_id, contact_id)
    select p_batch_id, c.id from public.contacts c where c.phone_e164 = any(p_phones)
    on conflict do nothing;
    get diagnostics v_count = row_count;
    return v_count;
  end;
  $$;
  revoke all on function public.link_import_batch_contacts(uuid, uuid, text[]) from public, anon, authenticated;
  grant execute on function public.link_import_batch_contacts(uuid, uuid, text[]) to service_role;

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
            select 1 from public.contact_marketing_suppressions s
            where s.phone_e164 = c.phone_e164 and s.released_at is null)
          and not exists (
            select 1 from public.meta_opt_outs o
            where o.waba_id = p_waba_id and o.phone_number_id = p_phone_number_id
              and o.identity_type = 'whatsapp_from'
              and o.identity_value in (c.phone_e164, substring(c.phone_e164 from 2)))
      ), false);
  $$;

  create or replace function public.create_whatsapp_campaign_draft(
    p_created_by uuid,
    p_name text,
    p_waba_id text,
    p_phone_number_id text,
    p_template_id text,
    p_template_name text,
    p_template_language text,
    p_template_snapshot jsonb,
    p_body_parameters jsonb,
    p_import_batch_id uuid,
    p_all_eligible boolean
  ) returns public.whatsapp_campaigns language plpgsql security definer
  set search_path = public, pg_temp
  as $$
  declare
    campaign public.whatsapp_campaigns;
    inserted_count integer;
    source_name text;
  begin
    if p_created_by is null or length(trim(coalesce(p_name, ''))) not between 1 and 120
      or nullif(p_waba_id, '') is null or nullif(p_phone_number_id, '') is null
      or nullif(p_template_id, '') is null or nullif(p_template_name, '') is null
      or nullif(p_template_language, '') is null
      or jsonb_typeof(p_template_snapshot) <> 'object'
      or jsonb_typeof(p_body_parameters) <> 'array'
      or p_all_eligible is distinct from (p_import_batch_id is null) then
      raise exception 'Invalid campaign draft';
    end if;
    if not p_all_eligible then
      select file_name into source_name
      from public.contact_import_batches where id = p_import_batch_id;
      if source_name is null then raise exception 'Import batch not found'; end if;
    else
      source_name := 'All eligible contacts';
    end if;

    insert into public.whatsapp_campaigns (
      created_by, name, audience_source, import_batch_id, audience_source_label,
      waba_id, phone_number_id, template_id, template_name,
      template_language, template_snapshot, body_parameters
    ) values (
      p_created_by, trim(p_name),
      case when p_all_eligible then 'all_eligible' else 'import_batch' end,
      p_import_batch_id, source_name,
      p_waba_id, p_phone_number_id, p_template_id,
      p_template_name, p_template_language, p_template_snapshot, p_body_parameters
    ) returning * into campaign;

    insert into public.whatsapp_campaign_recipients (
      campaign_id, contact_id, consent_event_id, recipient_e164
    )
    select campaign.id, contact.id, null, contact.phone_e164
    from public.contacts as contact
    where contact.phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
      and (p_all_eligible or exists (
        select 1 from public.contact_batch_members as member
        where member.batch_id = p_import_batch_id and member.contact_id = contact.id))
      and public.can_send_whatsapp_marketing(
        contact.id, p_waba_id, p_phone_number_id
      );
    get diagnostics inserted_count = row_count;

    update public.whatsapp_campaigns
    set audience_count = inserted_count, updated_at = now()
    where id = campaign.id returning * into campaign;
    insert into public.whatsapp_campaign_audit (campaign_id, actor_user_id, action,
                                                detail)
    values (campaign.id, p_created_by, 'create',
            jsonb_build_object(
              'audience_count', inserted_count,
              'audience_source', campaign.audience_source,
              'import_batch_id', campaign.import_batch_id,
              'audience_source_label', campaign.audience_source_label));
    return campaign;
  end;
  $$;
