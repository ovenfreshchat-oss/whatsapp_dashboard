-- One-step opt-in attestation for imported contacts (internal use).
-- Apply after 0002_contacts.sql. Safe to rerun.
--
-- An administrator confirms at upload time that the imported people agreed to receive
-- WhatsApp marketing messages. Each contact gets a verified consent event through the
-- existing record_contact_consent function, naming the administrator and the import batch,
-- so the audit trail and the can_send_whatsapp_marketing eligibility check are unchanged.
--
-- A number is skipped, never granted, when it has an active suppression (manual opt-out or
-- compliance hold) or a stored WhatsApp STOP. Attestation can never override an opt-out.
--
-- p_mode 'confirmed': the administrator ticked the confirmation box at import.
-- p_mode 'auto': internal-list mode (CONTACT_IMPORT_AUTO_ENABLE); contacts are enabled without a
-- tick, and the stored record says so honestly instead of claiming a confirmation.

drop function if exists public.attest_contacts_opt_in(uuid, uuid, text[]);

create or replace function public.attest_contacts_opt_in(
  p_batch_id uuid,
  p_actor_user_id uuid,
  p_phones text[],
  p_mode text default 'confirmed'
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text;
  v_contact_id uuid;
  v_key uuid;
  v_granted integer := 0;
  v_already integer := 0;
  v_suppressed integer := 0;
  v_unknown integer := 0;
  v_source text;
  v_notice text;
begin
  if p_batch_id is null or p_actor_user_id is null or p_phones is null
     or p_mode is null or p_mode not in ('confirmed', 'auto')
     or coalesce(array_length(p_phones, 1), 0) not between 1 and 5000 then
    raise exception 'Invalid opt-in attestation';
  end if;
  if p_mode = 'auto' then
    v_source := 'Automatic enablement at import (internal list)';
    v_notice := 'Added by an administrator to an internal contact list and enabled automatically at import. Individual opt-in was not separately verified in this system.';
  else
    v_source := 'Administrator attestation at import';
    v_notice := 'Administrator confirmed at upload that these contacts agreed to receive WhatsApp marketing messages from this business.';
  end if;

  -- Only the administrator who uploaded the batch may attest it. Locking the batch
  -- serializes a repeated request behind the first.
  perform 1 from public.contact_import_batches
  where id = p_batch_id and actor_user_id = p_actor_user_id for update;
  if not found then raise exception 'Import batch does not belong to this administrator'; end if;

  for v_phone in select distinct unnest(p_phones) loop
    if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then
      v_unknown := v_unknown + 1;
      continue;
    end if;
    select id into v_contact_id from public.contacts where phone_e164 = v_phone;
    if v_contact_id is null then
      v_unknown := v_unknown + 1;
      continue;
    end if;

    v_key := md5('opt-in-attestation:' || p_batch_id::text || ':' || v_contact_id::text)::uuid;
    if exists (select 1 from public.contact_consent_events where idempotency_key = v_key) then
      v_already := v_already + 1;
      continue;
    end if;

    if exists (
      select 1 from public.contact_marketing_suppressions
      where phone_e164 = v_phone and released_at is null
    ) or exists (
      select 1 from public.meta_opt_outs
      where identity_type = 'whatsapp_from'
        and identity_value in (v_phone, substring(v_phone from 2))
    ) then
      v_suppressed := v_suppressed + 1;
      continue;
    end if;

    perform public.record_contact_consent(
      v_key, v_contact_id, 'grant', v_source, v_notice,
      'contact import ' || p_batch_id::text, now(), p_actor_user_id
    );
    v_granted := v_granted + 1;
  end loop;

  return jsonb_build_object(
    'batch_id', p_batch_id, 'granted', v_granted, 'already_attested', v_already,
    'skipped_opted_out', v_suppressed, 'skipped_unknown', v_unknown
  );
end;
$$;

revoke all on function public.attest_contacts_opt_in(uuid, uuid, text[], text) from public, anon, authenticated;
grant execute on function public.attest_contacts_opt_in(uuid, uuid, text[], text) to service_role;
