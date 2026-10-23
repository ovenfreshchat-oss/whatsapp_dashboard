-- Run in a disposable PostgreSQL database after 0001 and 0002. Synthetic data only.
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000001');

set role service_role;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_batch uuid;
  v_result jsonb;
  v_contact uuid;
  v_claim uuid;
  v_missing_claim uuid;
  v_failed boolean := false;
begin
  v_result := public.import_contact_batch(
    '00000000-0000-4000-8000-000000000010', v_actor,
    'synthetic.csv', 'csv', repeat('a', 64),
    '[{"row_number":2,"phone_e164":"+14165550123","display_name":"Ada","consent_claimed":true,"evidence_reference":"form-17","consent_occurred_at":"2026-01-15T15:30:00.000Z"},{"row_number":3,"phone_e164":"+447911123456","display_name":"Bea","consent_claimed":true,"evidence_reference":null,"consent_occurred_at":null}]'::jsonb,
    '[{"row_number":4,"code":"invalid_phone","message":"Invalid phone."},{"row_number":4,"code":"name_too_long","message":"Name too long."}]'::jsonb
  );
  if v_result->>'inserted' <> '2' or v_result->>'consent_claims' <> '2'
     or v_result->>'rejected_rows' <> '1' then
    raise exception 'Import counts are wrong: %', v_result;
  end if;
  v_batch := (v_result->>'batch_id')::uuid;
  if (select count(*) from public.contact_import_row_errors where batch_id = v_batch) <> 2 then
    raise exception 'Multiple errors for one row were lost';
  end if;
  if public.import_contact_batch(
    '00000000-0000-4000-8000-000000000010', v_actor,
    'synthetic.csv', 'csv', repeat('a', 64),
    '[{"row_number":2,"phone_e164":"+14165550123","display_name":"Ada","consent_claimed":true,"evidence_reference":"form-17","consent_occurred_at":"2026-01-15T15:30:00.000Z"},{"row_number":3,"phone_e164":"+447911123456","display_name":"Bea","consent_claimed":true,"evidence_reference":null,"consent_occurred_at":null}]'::jsonb,
    '[{"row_number":4,"code":"invalid_phone","message":"Invalid phone."},{"row_number":4,"code":"name_too_long","message":"Name too long."}]'::jsonb
  )->>'batch_id' is distinct from v_batch::text then
    raise exception 'Import replay was not idempotent';
  end if;
  select id into v_contact from public.contacts where phone_e164 = '+14165550123';
  select id into v_claim from public.contact_consent_events
    where import_batch_id = v_batch and import_row_number = 2;
  select id into v_missing_claim from public.contact_consent_events
    where import_batch_id = v_batch and import_row_number = 3;
  if public.can_send_whatsapp_marketing(v_contact, 'waba-1', 'phone-1') then
    raise exception 'Pending imported consent became sendable';
  end if;
  begin
    perform public.review_imported_consent_claim(v_missing_claim, v_actor,
      'website form', 'I agree to WhatsApp marketing.', 'grant');
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'Missing evidence was approved'; end if;
  perform public.review_imported_consent_claim(v_claim, v_actor,
    'website form', 'I agree to WhatsApp marketing.', 'grant');
  if not public.can_send_whatsapp_marketing(v_contact, 'waba-1', 'phone-1') then
    raise exception 'Evidenced reviewed consent stayed blocked';
  end if;
  v_result := public.review_imported_consent_batch(
    v_batch, v_actor, 'website form', 'I agree to WhatsApp marketing.',
    '00000000-0000-4000-8000-000000000011');
  if v_result->>'reviewed' <> '0' or v_result->>'skipped' <> '1' then
    raise exception 'Batch review did not skip missing evidence: %', v_result;
  end if;
  perform public.record_contact_consent(
    '00000000-0000-4000-8000-000000000012', v_contact, 'revoke',
    'customer request', null, null, now(), v_actor);
  if public.can_send_whatsapp_marketing(v_contact, 'waba-1', 'phone-1') then
    raise exception 'Revocation did not suppress marketing';
  end if;
  v_result := public.import_contact_batch(
    '00000000-0000-4000-8000-000000000013', v_actor,
    'manual-stays.csv', 'csv', repeat('c', 64),
    '[{"row_number":2,"phone_e164":"+14165550123","consent_claimed":false,"consent_explicit_no":true}]'::jsonb,
    '[]'::jsonb);
  if v_result->>'negative_consent_rows' <> '1'
     or (select reason from public.contact_marketing_suppressions
         where phone_e164 = '+14165550123') <> 'manual_opt_out' then
    raise exception 'Negative import replaced a manual opt-out: %', v_result;
  end if;
end;
$$;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_contact uuid;
  v_result jsonb;
begin
  select id into v_contact from public.contacts where phone_e164 = '+447911123456';
  perform public.record_contact_consent(
    '00000000-0000-4000-8000-000000000014', v_contact, 'grant',
    'website form', 'I agree to WhatsApp marketing.', 'separate-form-18',
    now() - interval '1 day', v_actor);
  if not public.can_send_whatsapp_marketing(v_contact, 'waba-1', 'phone-1') then
    raise exception 'Separately evidenced opt-in was not sendable';
  end if;
  v_result := public.import_contact_batch(
    '00000000-0000-4000-8000-000000000015', v_actor,
    'negative.csv', 'csv', repeat('d', 64),
    '[{"row_number":2,"phone_e164":"+447911123456","consent_claimed":false,"consent_explicit_no":true}]'::jsonb,
    '[]'::jsonb);
  if v_result->>'negative_consent_rows' <> '1'
     or public.can_send_whatsapp_marketing(v_contact, 'waba-1', 'phone-1') then
    raise exception 'Explicit imported No failed to block prior consent: %', v_result;
  end if;
  if (select reason from public.contact_marketing_suppressions
      where phone_e164 = '+447911123456') <> 'compliance_hold' then
    raise exception 'Explicit No lacks durable compliance hold';
  end if;
end;
$$;

select pg_sleep(0.02);

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_contact uuid;
begin
  select id into v_contact from public.contacts where phone_e164 = '+447911123456';
  perform public.record_contact_consent(
    '00000000-0000-4000-8000-000000000016', v_contact, 'grant',
    'fresh website form', 'I agree to WhatsApp marketing.', 'fresh-form-19',
    now(), v_actor);
  if not public.can_send_whatsapp_marketing(v_contact, 'waba-1', 'phone-1')
     or (select released_at from public.contact_marketing_suppressions
         where phone_e164 = '+447911123456') is null then
    raise exception 'Fresh reviewed grant did not release import-only hold';
  end if;
end;
$$;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000001';
  v_import jsonb;
  v_batch uuid;
  v_contact uuid;
  v_claim uuid;
  v_today date := (now() at time zone 'UTC')::date;
  v_today_floor timestamptz;
  v_failed boolean := false;
begin
  v_import := public.import_contact_batch(
    '00000000-0000-4000-8000-000000000017', v_actor,
    'date-only.csv', 'csv', repeat('e', 64),
    '[{"row_number":2,"phone_e164":"+61491570156","display_name":"Cara","consent_claimed":true,"consent_explicit_no":false,"evidence_reference":"dated-form-20","consent_occurred_at":"2026-01-14T10:00:00.000Z","consent_occurred_on":"2026-01-15"}]'::jsonb,
    '[]'::jsonb);
  v_batch := (v_import->>'batch_id')::uuid;
  select contact.id, event.id into v_contact, v_claim
  from public.contacts contact join public.contact_consent_events event
    on event.contact_id = contact.id
  where event.import_batch_id = v_batch;
  if (select occurred_on from public.contact_consent_events where id = v_claim)
     <> date '2026-01-15' then
    raise exception 'Date-only evidence precision was lost';
  end if;
  perform public.review_imported_consent_claim(v_claim, v_actor,
    'dated website form', 'I agree to WhatsApp marketing.', 'grant');
  if not public.can_send_whatsapp_marketing(v_contact, 'waba-1', 'phone-1') then
    raise exception 'Old date-only evidence could not be reviewed';
  end if;
  -- A revocation during the same calendar date must sort after the earliest
  -- possible consent instant. Direct insert avoids a separate suppression gate.
  insert into public.contact_consent_events (
    contact_id, decision, verification_status, source, occurred_at,
    reviewed_by, reviewed_at
  ) values (
    v_contact, 'revoke', 'verified', 'customer request',
    '2026-01-15T12:00:00Z'::timestamptz, v_actor, now()
  );
  if public.can_send_whatsapp_marketing(v_contact, 'waba-1', 'phone-1') then
    raise exception 'Date-only grant superseded a same-day revocation';
  end if;

  v_today_floor := (v_today::timestamp at time zone 'UTC') - interval '14 hours';
  v_import := public.import_contact_batch(
    '00000000-0000-4000-8000-000000000018', v_actor,
    'today-date.csv', 'csv', repeat('f', 64),
    jsonb_build_array(jsonb_build_object(
      'row_number', 2, 'phone_e164', '+33612345678',
      'consent_claimed', true, 'evidence_reference', 'dated-form-21',
      'consent_occurred_at', to_char(v_today_floor at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'consent_occurred_on', v_today::text)),
    '[]'::jsonb);
  select id into v_claim from public.contact_consent_events
  where import_batch_id = (v_import->>'batch_id')::uuid;
  begin
    perform public.review_imported_consent_claim(v_claim, v_actor,
      'today website form', 'I agree to WhatsApp marketing.', 'grant');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'Current date-only evidence was reviewed too soon'; end if;
end;
$$;

reset role;

do $$
begin
  if has_table_privilege('authenticated', 'public.contacts', 'SELECT')
     or has_function_privilege('authenticated',
       'public.import_contact_batch(uuid,uuid,text,text,text,jsonb,jsonb)', 'EXECUTE') then
    raise exception 'Contact data is exposed to authenticated clients';
  end if;
  if has_function_privilege('service_role',
       'public.release_import_consent_hold(uuid)', 'EXECUTE') then
    raise exception 'Import hold release helper is directly callable';
  end if;
end;
$$;
