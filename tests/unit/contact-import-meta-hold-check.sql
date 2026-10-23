-- Run after 0001 in a disposable PostgreSQL database. Synthetic data only.
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000201');

set role service_role;

do $$
declare
  v_actor uuid := '00000000-0000-4000-8000-000000000201';
  v_failed boolean;
  v_hold public.meta_sender_holds;
  v_source text;
begin
  for v_source in select unnest(array[repeat('a', 64), repeat('b', 64)]) loop
    perform public.receive_meta_whatsapp_webhook(
      encode(digest('envelope-' || v_source, 'sha256'), 'hex'),
      '{}'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'dedupe_key', v_source, 'kind', 'message', 'waba_id', 'waba-hold',
        'phone_number_id', 'phone-hold', 'field', 'messages',
        'needs_review', true, 'payload', jsonb_build_object('text', 'ambiguous'))),
      jsonb_build_array(jsonb_build_object(
        'source_item_key', v_source, 'waba_id', 'waba-hold',
        'phone_number_id', 'phone-hold', 'hold_only', true)));
  end loop;
  if (select count(*) from public.meta_ambiguous_opt_out_events
      where waba_id = 'waba-hold' and reviewed_at is null) <> 2 then
    raise exception 'Both ambiguous sources were not recorded';
  end if;
  v_failed := false;
  begin
    perform public.release_meta_ambiguous_sender_hold(
      'waba-hold', 'phone-hold', repeat('c', 64), v_actor,
      'The unrelated source must not release this hold.');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'Stale source review was accepted'; end if;

  update public.meta_webhook_items
  set received_at = now() - interval '3 days', processed_at = now()
  where dedupe_key = repeat('a', 64);
  perform public.redact_meta_webhook_payloads(now() - interval '1 day');
  if (select payload from public.meta_webhook_items
      where dedupe_key = repeat('a', 64)) = '{}'::jsonb then
    raise exception 'Retention erased unresolved review evidence';
  end if;
  v_hold := public.release_meta_ambiguous_sender_hold(
    'waba-hold', 'phone-hold', repeat('a', 64), v_actor,
    'Reviewed first ambiguous request against its inbound text.');
  if v_hold.released_at is not null then
    raise exception 'First of two ambiguous reviews released the hold';
  end if;
  perform public.redact_meta_webhook_payloads(now() - interval '1 day');
  if (select payload from public.meta_webhook_items
      where dedupe_key = repeat('a', 64)) <> '{}'::jsonb then
    raise exception 'Resolved review evidence was not redacted';
  end if;
  v_hold := public.release_meta_ambiguous_sender_hold(
    'waba-hold', 'phone-hold', repeat('b', 64), v_actor,
    'Reviewed second ambiguous request against its inbound text.');
  if v_hold.released_at is null
     or (select count(*) from public.meta_sender_hold_reviews
         where waba_id = 'waba-hold') <> 2 then
    raise exception 'Second review failed to release and audit the hold';
  end if;
  perform public.receive_meta_whatsapp_webhook(
    encode(digest('rewrapped-duplicate', 'sha256'), 'hex'),
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('a', 64), 'kind', 'message', 'waba_id', 'waba-hold',
      'phone_number_id', 'phone-hold', 'field', 'messages',
      'needs_review', true, 'payload', jsonb_build_object('text', 'replayed'))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('a', 64), 'waba_id', 'waba-hold',
      'phone_number_id', 'phone-hold', 'hold_only', true)));
  if (select released_at from public.meta_sender_holds
      where waba_id = 'waba-hold' and phone_number_id = 'phone-hold') is null
     or (select count(*) from public.meta_ambiguous_opt_out_events
         where waba_id = 'waba-hold' and reviewed_at is null) <> 0 then
    raise exception 'Duplicate source replay reopened a reviewed hold';
  end if;

  perform public.receive_meta_whatsapp_webhook(
    encode(digest('clear-stop', 'sha256'), 'hex'),
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('c', 64), 'kind', 'message', 'waba_id', 'waba-hold',
      'phone_number_id', 'phone-hold', 'field', 'messages',
      'needs_review', true, 'payload', jsonb_build_object('text', 'STOP'))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('c', 64), 'waba_id', 'waba-hold',
      'phone_number_id', 'phone-hold', 'hold_only', false,
      'identity_value', '+14165550123')));
  if (select reason from public.meta_sender_holds
      where waba_id = 'waba-hold' and phone_number_id = 'phone-hold') <> 'unreconciled_opt_out'
     or (select released_at from public.meta_sender_holds
         where waba_id = 'waba-hold' and phone_number_id = 'phone-hold') is not null then
    raise exception 'Later clear STOP did not restore a confirmed sender hold';
  end if;
  v_failed := false;
  begin
    perform public.release_meta_ambiguous_sender_hold(
      'waba-hold', 'phone-hold', repeat('c', 64), v_actor,
      'A clear STOP must stay blocked from ambiguous review.');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'Clear STOP was released by ambiguous review'; end if;

  perform public.receive_meta_whatsapp_webhook(
    encode(digest('ambiguous-confirmed', 'sha256'), 'hex'),
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'dedupe_key', repeat('d', 64), 'kind', 'message', 'waba_id', 'waba-other',
      'phone_number_id', 'phone-other', 'field', 'messages',
      'needs_review', true, 'payload', jsonb_build_object('text', 'maybe'))),
    jsonb_build_array(jsonb_build_object(
      'source_item_key', repeat('d', 64), 'waba_id', 'waba-other',
      'phone_number_id', 'phone-other', 'hold_only', true)));
  insert into public.meta_opt_outs (
    waba_id, phone_number_id, identity_value, source_item_key
  ) values ('waba-other', 'phone-other', '+447911123456', repeat('d', 64));
  v_failed := false;
  begin
    perform public.release_meta_ambiguous_sender_hold(
      'waba-other', 'phone-other', repeat('d', 64), v_actor,
      'The confirmed opt-out must not be released.');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'Confirmed opt-out was released'; end if;
end;
$$;

reset role;
