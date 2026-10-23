-- Run after 0001 in a disposable PostgreSQL database. Synthetic data only.
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000202');

set role service_role;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000202';
  v_hold public.meta_sender_holds;
  v_failed boolean;
begin
  perform public.receive_meta_whatsapp_webhook(
    encode(digest('confirmed-one', 'sha256'), 'hex'), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('1', 64), 'kind', 'message', 'waba_id', 'waba-confirmed',
      'phone_number_id', 'phone-confirmed', 'field', 'messages',
      'needs_review', true,
      'payload', jsonb_build_object('from', '14165550101', 'text', jsonb_build_object('body', 'STOP')))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('1', 64), 'waba_id', 'waba-confirmed',
      'phone_number_id', 'phone-confirmed', 'hold_only', false,
      'identity_value', '14165550101')));
  perform public.receive_meta_whatsapp_webhook(
    encode(digest('confirmed-two', 'sha256'), 'hex'), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('2', 64), 'kind', 'message', 'waba_id', 'waba-confirmed',
      'phone_number_id', 'phone-confirmed', 'field', 'messages',
      'needs_review', true,
      'payload', jsonb_build_object('from', '14165550102', 'text', jsonb_build_object('body', 'STOP')))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('2', 64), 'waba_id', 'waba-confirmed',
      'phone_number_id', 'phone-confirmed', 'hold_only', false,
      'identity_value', '14165550102')));

  if (select count(*) from public.meta_confirmed_opt_out_events
      where waba_id = 'waba-confirmed' and reviewed_at is null) <> 2
     or (select count(*) from public.meta_opt_outs
         where waba_id = 'waba-confirmed') <> 2 then
    raise exception 'Both STOP events and suppressions must be stored';
  end if;
  v_failed := false;
  begin
    perform public.reconcile_meta_confirmed_sender_hold(
      'waba-confirmed', 'phone-confirmed', repeat('1', 64), v_actor,
      '+14165550199', 'A mismatched recipient must not be reconciled.');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'Mismatched recipient was accepted'; end if;

  v_hold := public.reconcile_meta_confirmed_sender_hold(
    'waba-confirmed', 'phone-confirmed', repeat('1', 64), v_actor,
    '+14165550101', 'Checked the first STOP and WhatsApp identity against the stored opt-out.');
  if v_hold.released_at is not null
     or (select count(*) from public.meta_confirmed_opt_out_events
         where waba_id = 'waba-confirmed' and reviewed_at is null) <> 1 then
    raise exception 'First STOP review released a hold with another pending STOP';
  end if;
  v_hold := public.reconcile_meta_confirmed_sender_hold(
    'waba-confirmed', 'phone-confirmed', repeat('2', 64), v_actor,
    '+14165550102', 'Checked the second STOP and WhatsApp identity against the stored opt-out.');
  if v_hold.released_at is null
     or (select count(*) from public.meta_sender_hold_reviews
         where waba_id = 'waba-confirmed' and review_kind = 'unreconciled_opt_out') <> 2
     or (select count(*) from public.meta_opt_outs
         where waba_id = 'waba-confirmed') <> 2 then
    raise exception 'Final review did not release, audit, and retain recipient opt-outs';
  end if;

  -- Another STOP from the same identity must create its own review event while
  -- retaining the existing unique recipient suppression.
  perform public.receive_meta_whatsapp_webhook(
    encode(digest('confirmed-same-identity', 'sha256'), 'hex'), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('5', 64), 'kind', 'message', 'waba_id', 'waba-confirmed',
      'phone_number_id', 'phone-confirmed', 'field', 'messages',
      'needs_review', true,
      'payload', jsonb_build_object('from', '14165550101', 'text', jsonb_build_object('body', 'STOP')))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('5', 64), 'waba_id', 'waba-confirmed',
      'phone_number_id', 'phone-confirmed', 'hold_only', false,
      'identity_value', '14165550101')));
  if (select count(*) from public.meta_opt_outs
      where waba_id = 'waba-confirmed') <> 2
     or (select released_at from public.meta_sender_holds
         where waba_id = 'waba-confirmed' and phone_number_id = 'phone-confirmed') is not null then
    raise exception 'Repeat STOP changed suppression cardinality or failed to reactivate hold';
  end if;
  v_hold := public.reconcile_meta_confirmed_sender_hold(
    'waba-confirmed', 'phone-confirmed', repeat('5', 64), v_actor,
    '+14165550101', 'Reviewed the repeated STOP from an identity with an existing suppression.');
  if v_hold.released_at is null
     or (select count(*) from public.meta_sender_hold_reviews
         where waba_id = 'waba-confirmed' and review_kind = 'unreconciled_opt_out') <> 3 then
    raise exception 'Repeat STOP was not independently reviewed and released';
  end if;

  perform public.receive_meta_whatsapp_webhook(
    encode(digest('confirmed-rewrapped-replay', 'sha256'), 'hex'), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('1', 64), 'kind', 'message', 'waba_id', 'waba-confirmed',
      'phone_number_id', 'phone-confirmed', 'field', 'messages',
      'needs_review', true,
      'payload', jsonb_build_object('from', '14165550101', 'text', jsonb_build_object('body', 'STOP')))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('1', 64), 'waba_id', 'waba-confirmed',
      'phone_number_id', 'phone-confirmed', 'hold_only', false,
      'identity_value', '14165550101')));
  if (select released_at from public.meta_sender_holds
      where waba_id = 'waba-confirmed' and phone_number_id = 'phone-confirmed') is null then
    raise exception 'Rewrapped duplicate STOP reopened the reviewed hold';
  end if;

  perform public.receive_meta_whatsapp_webhook(
    encode(digest('mixed-ambiguous', 'sha256'), 'hex'), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('3', 64), 'kind', 'message', 'waba_id', 'waba-mixed',
      'phone_number_id', 'phone-mixed', 'field', 'messages',
      'needs_review', true,
      'payload', jsonb_build_object('from', '14165550103', 'text', jsonb_build_object('body', 'Please stop messaging me')))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('3', 64), 'waba_id', 'waba-mixed',
      'phone_number_id', 'phone-mixed', 'hold_only', true,
      'identity_value', '14165550103')));
  perform public.receive_meta_whatsapp_webhook(
    encode(digest('mixed-confirmed', 'sha256'), 'hex'), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('4', 64), 'kind', 'message', 'waba_id', 'waba-mixed',
      'phone_number_id', 'phone-mixed', 'field', 'messages',
      'needs_review', true,
      'payload', jsonb_build_object('from', '14165550104', 'text', jsonb_build_object('body', 'STOP')))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('4', 64), 'waba_id', 'waba-mixed',
      'phone_number_id', 'phone-mixed', 'hold_only', false,
      'identity_value', '14165550104')));
  v_hold := public.reconcile_meta_confirmed_sender_hold(
    'waba-mixed', 'phone-mixed', repeat('4', 64), v_actor,
    '+14165550104', 'Checked the clear STOP and its matching recipient suppression.');
  if v_hold.released_at is not null or v_hold.reason <> 'ambiguous_opt_out'
     or v_hold.source_item_key <> repeat('3', 64) then
    raise exception 'Mixed hold failed to retain its unresolved ambiguous event';
  end if;
  v_hold := public.release_meta_ambiguous_sender_hold(
    'waba-mixed', 'phone-mixed', repeat('3', 64), v_actor,
    'Reviewed the remaining ambiguous message after the STOP was suppressed.');
  if v_hold.released_at is null
     or not exists (select 1 from public.meta_opt_outs
         where waba_id = 'waba-mixed' and identity_value = '14165550104') then
    raise exception 'Final ambiguous review did not release while retaining suppression';
  end if;
end;
$$;

reset role;
