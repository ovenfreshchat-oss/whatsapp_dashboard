-- Run after 0001, 0002, and 0003 in a disposable PostgreSQL database.
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000101');

set role service_role;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000101';
  v_import jsonb;
  v_batch uuid;
  v_other_batch uuid;
  v_contact_ids uuid[];
  v_revoked_contact uuid;
  v_campaign public.whatsapp_campaigns;
  v_unreviewed_scheduled boolean := false;
  v_invalid_source_accepted boolean := false;
begin
  v_import := public.import_contact_batch(
    '00000000-0000-4000-8000-000000000110', v_actor,
    'synthetic-campaign.csv', 'csv', repeat('b', 64),
    '[{"row_number":2,"phone_e164":"+14165550123","display_name":"Ada","consent_claimed":true,"evidence_reference":"form-17","consent_occurred_at":"2026-01-15T15:30:00.000Z"},{"row_number":3,"phone_e164":"+447911123456","display_name":"Bea","consent_claimed":true,"evidence_reference":"form-18","consent_occurred_at":"2026-01-15T15:31:00.000Z"}]'::jsonb,
    '[]'::jsonb
  );
  v_batch := (v_import->>'batch_id')::uuid;
  if public.review_imported_consent_batch(
    v_batch, v_actor, 'website form', 'I agree to WhatsApp marketing.',
    '00000000-0000-4000-8000-000000000111'
  )->>'reviewed' <> '2' then
    raise exception 'Evidenced batch review did not verify both claims';
  end if;
  select array_agg(id order by phone_e164) into v_contact_ids
  from public.contacts where phone_e164 in ('+14165550123', '+447911123456');
  if cardinality(v_contact_ids) <> 2 then raise exception 'Contacts were not imported'; end if;
  v_import := public.import_contact_batch(
    '00000000-0000-4000-8000-000000000113', v_actor,
    'other-batch.csv', 'csv', repeat('e', 64),
    '[{"row_number":2,"phone_e164":"+61491570156","display_name":"Cara","consent_claimed":true,"evidence_reference":"form-19","consent_occurred_at":"2026-01-15T15:32:00.000Z"}]'::jsonb,
    '[]'::jsonb);
  v_other_batch := (v_import->>'batch_id')::uuid;
  perform public.review_imported_consent_batch(
    v_other_batch, v_actor, 'website form', 'I agree to WhatsApp marketing.',
    '00000000-0000-4000-8000-000000000114');
  if (select count(*) from public.contacts contact
      where public.can_send_whatsapp_marketing(contact.id, 'waba-1', 'phone-1')) <> 3 then
    raise exception 'Expected three globally eligible contacts before draft';
  end if;
  begin
    perform public.create_whatsapp_campaign_draft(
      v_actor, 'Invalid source', 'waba-1', 'phone-1', 'template-1', 'pilot_offer', 'en_US',
      '{"id":"template-1","name":"pilot_offer","language":"en_US","category":"MARKETING","status":"APPROVED","components":[{"type":"BODY","text":"Hello"}]}'::jsonb,
      '[]'::jsonb, null, false);
    v_invalid_source_accepted := true;
  exception when others then
    null;
  end;
  if v_invalid_source_accepted then raise exception 'Draft accepted missing audience source'; end if;
  v_campaign := public.create_whatsapp_campaign_draft(
    v_actor, 'Synthetic pilot', 'waba-1', 'phone-1', 'template-1', 'pilot_offer', 'en_US',
    '{"id":"template-1","name":"pilot_offer","language":"en_US","category":"MARKETING","status":"APPROVED","components":[{"type":"BODY","text":"Hello"}]}'::jsonb,
    '[]'::jsonb, v_batch, false
  );
  if v_campaign.audience_count <> 2 then
    raise exception 'Batch audience included a contact from another import: %', v_campaign.audience_count;
  end if;
  begin
    perform public.transition_whatsapp_campaign(
      v_campaign.id, v_actor, 'schedule', now() + interval '1 second');
    v_unreviewed_scheduled := true;
  exception when others then
    null;
  end;
  if v_unreviewed_scheduled then raise exception 'Schedule accepted without audience review'; end if;
  v_campaign := public.transition_whatsapp_campaign(
    v_campaign.id, v_actor, 'schedule', now() + interval '1 second',
    true, v_campaign.audience_count, v_campaign.review_sha256);
  if v_campaign.state <> 'scheduled' then raise exception 'Draft was not scheduled'; end if;
  select id into v_revoked_contact from public.contacts where phone_e164 = '+447911123456';
  perform public.record_contact_consent(
    '00000000-0000-4000-8000-000000000112', v_revoked_contact, 'revoke',
    'customer request', null, null, now(), v_actor);
end;
$$;

select pg_sleep(2);

do $$
declare
  v_recipient public.whatsapp_campaign_recipients;
  v_campaign_id uuid;
  v_gate text;
  v_claimed integer := 0;
  v_allowed integer := 0;
  v_suppressed integer := 0;
  v_counts jsonb;
begin
  for v_recipient in select * from public.claim_whatsapp_campaign_recipients(2) loop
    v_claimed := v_claimed + 1;
    v_campaign_id := v_recipient.campaign_id;
    v_gate := public.whatsapp_campaign_send_gate(v_recipient.id);
    if v_gate = 'allowed' then
      v_allowed := v_allowed + 1;
      perform public.record_whatsapp_campaign_send_result(
        v_recipient.id, 'accepted', 'wamid.synthetic-campaign', null);
    elsif v_gate = 'suppressed' then
      v_suppressed := v_suppressed + 1;
      perform public.record_whatsapp_campaign_send_result(
        v_recipient.id, 'suppressed', null, 'Opted out before send');
    else
      raise exception 'Unexpected send gate: %', v_gate;
    end if;
  end loop;
  if v_claimed <> 2 or v_allowed <> 1 or v_suppressed <> 1 then
    raise exception 'Claim or final eligibility gate was wrong';
  end if;
  if public.finish_whatsapp_campaigns() <> 1 then
    raise exception 'Terminal campaign did not complete';
  end if;
  v_counts := public.whatsapp_campaign_counts(v_campaign_id);
  if v_counts->>'accepted' <> '1' or v_counts->>'suppressed' <> '1' then
    raise exception 'Campaign counts are wrong: %', v_counts;
  end if;
end;
$$;

reset role;
