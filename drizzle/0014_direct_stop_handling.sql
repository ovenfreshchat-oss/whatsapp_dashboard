-- Direct STOP handling. A clear STOP from a real phone number is now blocked immediately
-- (meta_opt_outs, which 0013 copies into opt_out_numbers) and marked reviewed, and it no
-- longer puts a sender-wide hold on the inbox. Ambiguous messages ("please don't message
-- me") and STOPs without a usable phone identity still create a hold for manual review.
-- Also clears holds that exist only because of clear STOPs whose opt-out is already stored.
-- Apply after 0013. Safe to rerun.

create or replace function public.receive_meta_whatsapp_webhook(
  p_payload_sha256 text,
  p_payload jsonb,
  p_items jsonb,
  p_opt_outs jsonb
) returns uuid language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_envelope_id uuid;
  item jsonb;
  opt_out jsonb;
begin
  if p_payload_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_payload) <> 'object'
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_typeof(p_opt_outs) <> 'array' then
    raise exception 'Invalid Meta webhook receipt input';
  end if;

  insert into public.meta_webhook_envelopes (payload_sha256, raw_payload)
  values (p_payload_sha256, p_payload)
  on conflict (payload_sha256) do nothing
  returning id into v_envelope_id;
  if v_envelope_id is null then
    select id into v_envelope_id from public.meta_webhook_envelopes
    where payload_sha256 = p_payload_sha256;
    return v_envelope_id;
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    insert into public.meta_webhook_items (
      envelope_id, dedupe_key, kind, waba_id, phone_number_id, field,
      provider_message_id, provider_status, event_timestamp, needs_review, payload
    ) values (
      v_envelope_id, item->>'dedupe_key', item->>'kind', item->>'waba_id',
      item->>'phone_number_id', item->>'field', item->>'provider_message_id',
      item->>'provider_status', nullif(item->>'event_timestamp', '')::timestamptz,
      coalesce((item->>'needs_review')::boolean, false), item->'payload'
    ) on conflict (dedupe_key) do nothing;

    if item->>'kind' = 'status' then
      perform public.project_meta_test_send_status(
        item->>'waba_id', item->>'phone_number_id', item->>'provider_message_id',
        item->>'provider_status', nullif(item->>'event_timestamp', '')::timestamptz
      );
    end if;
  end loop;

  for opt_out in select value from jsonb_array_elements(p_opt_outs) loop
    -- A rewrapped webhook can carry an already stored message ID. Its earlier
    -- transactional opt-out decision must not be reopened after admin review.
    if not exists (
      select 1 from public.meta_webhook_items source
      where source.dedupe_key = opt_out->>'source_item_key'
        and source.envelope_id = v_envelope_id and source.kind = 'message'
    ) then
      continue;
    end if;
    -- Direct path: a clear STOP from a real phone identity is recorded as a
    -- recipient-specific opt-out and marked reviewed. It does not hold the sender.
    -- Anything ambiguous, or without a usable phone identity, still takes the hold below.
    if not coalesce((opt_out->>'hold_only')::boolean, false)
       and coalesce(opt_out->>'identity_value', '') ~ '^\+?[1-9][0-9]{7,14}$' then
      insert into public.meta_opt_outs (
        waba_id, phone_number_id, identity_value, source_item_key, source_message_id
      ) values (
        opt_out->>'waba_id', opt_out->>'phone_number_id', opt_out->>'identity_value',
        opt_out->>'source_item_key', opt_out->>'source_message_id'
      ) on conflict (waba_id, phone_number_id, identity_type, identity_value) do nothing;
      insert into public.meta_confirmed_opt_out_events (
        source_item_key, waba_id, phone_number_id, identity_value, reviewed_at
      ) values (
        opt_out->>'source_item_key', opt_out->>'waba_id',
        opt_out->>'phone_number_id', opt_out->>'identity_value', now()
      ) on conflict (source_item_key) do nothing;
      update public.meta_webhook_items set needs_review = false
      where dedupe_key = opt_out->>'source_item_key';
      continue;
    end if;
    -- A hold is deliberately conservative until a contact/identity mapping is reviewed.
    insert into public.meta_sender_holds (
      waba_id, phone_number_id, reason, source_item_key
    ) values (
      opt_out->>'waba_id', opt_out->>'phone_number_id',
      case when coalesce((opt_out->>'hold_only')::boolean, false)
           then 'ambiguous_opt_out' else 'unreconciled_opt_out' end,
      opt_out->>'source_item_key'
    ) on conflict (waba_id, phone_number_id) do update
      set released_at = null,
          source_item_key = case
            when public.meta_sender_holds.reason = 'unreconciled_opt_out'
              and public.meta_sender_holds.released_at is null
              and excluded.reason = 'ambiguous_opt_out'
            then public.meta_sender_holds.source_item_key
            else excluded.source_item_key end,
          reason = case
            when public.meta_sender_holds.reason = 'unreconciled_opt_out'
              and public.meta_sender_holds.released_at is null
            then 'unreconciled_opt_out'
            else excluded.reason end,
          created_at = now()
      where public.meta_sender_holds.source_item_key is distinct from excluded.source_item_key
         or public.meta_sender_holds.released_at is not null;

    if coalesce((opt_out->>'hold_only')::boolean, false) then
      insert into public.meta_ambiguous_opt_out_events (
        source_item_key, waba_id, phone_number_id
      ) values (
        opt_out->>'source_item_key', opt_out->>'waba_id', opt_out->>'phone_number_id'
      ) on conflict (source_item_key) do nothing;
    else
      insert into public.meta_confirmed_opt_out_events (
        source_item_key, waba_id, phone_number_id, identity_value
      ) values (
        opt_out->>'source_item_key', opt_out->>'waba_id',
        opt_out->>'phone_number_id', nullif(opt_out->>'identity_value', '')
      ) on conflict (source_item_key) do nothing;
      if nullif(opt_out->>'identity_value', '') is not null then
        insert into public.meta_opt_outs (
          waba_id, phone_number_id, identity_value, source_item_key, source_message_id
        ) values (
          opt_out->>'waba_id', opt_out->>'phone_number_id', opt_out->>'identity_value',
          opt_out->>'source_item_key', opt_out->>'source_message_id'
        ) on conflict (waba_id, phone_number_id, identity_type, identity_value) do nothing;
      end if;
    end if;
  end loop;

  return v_envelope_id;
end;
$$;

update public.meta_confirmed_opt_out_events event
set reviewed_at = now()
where event.reviewed_at is null
  and event.identity_value ~ '^\+?[1-9][0-9]{7,14}$'
  and exists (
    select 1 from public.meta_opt_outs o
    where o.waba_id = event.waba_id and o.phone_number_id = event.phone_number_id
      and o.identity_type = 'whatsapp_from' and o.identity_value = event.identity_value);

update public.meta_webhook_items item set needs_review = false
where item.kind = 'message' and item.needs_review
  and exists (select 1 from public.meta_confirmed_opt_out_events e
              where e.source_item_key = item.dedupe_key and e.reviewed_at is not null);

-- Hold only for what still needs a person: ambiguous messages or unmappable STOPs.
update public.meta_sender_holds hold
set released_at = now()
where hold.released_at is null
  and not exists (select 1 from public.meta_confirmed_opt_out_events e
                  where e.waba_id = hold.waba_id and e.phone_number_id = hold.phone_number_id
                    and e.reviewed_at is null)
  and not exists (select 1 from public.meta_ambiguous_opt_out_events e
                  where e.waba_id = hold.waba_id and e.phone_number_id = hold.phone_number_id
                    and e.reviewed_at is null);

update public.meta_sender_holds hold
set reason = 'ambiguous_opt_out',
    source_item_key = (select e.source_item_key from public.meta_ambiguous_opt_out_events e
                       where e.waba_id = hold.waba_id and e.phone_number_id = hold.phone_number_id
                         and e.reviewed_at is null
                       order by e.received_at, e.source_item_key limit 1)
where hold.released_at is null
  and hold.reason = 'unreconciled_opt_out'
  and not exists (select 1 from public.meta_confirmed_opt_out_events e
                  where e.waba_id = hold.waba_id and e.phone_number_id = hold.phone_number_id
                    and e.reviewed_at is null)
  and exists (select 1 from public.meta_ambiguous_opt_out_events e
              where e.waba_id = hold.waba_id and e.phone_number_id = hold.phone_number_id
                and e.reviewed_at is null);
