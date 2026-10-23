-- Apply to the Supabase PostgreSQL project before enabling the Meta webhook URL.
-- The service-role RPC commits the envelope, each nested event, and urgent opt-outs together.
create extension if not exists pgcrypto;

create table if not exists public.meta_webhook_envelopes (
  id uuid primary key default gen_random_uuid(),
  payload_sha256 text not null unique check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  raw_payload jsonb,
  received_at timestamptz not null default now()
);

-- Keep the envelope digest for replay detection after the raw payload expires.
alter table public.meta_webhook_envelopes alter column raw_payload drop not null;

create table if not exists public.meta_webhook_items (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null references public.meta_webhook_envelopes(id),
  dedupe_key text not null unique check (dedupe_key ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('message', 'status', 'change')),
  waba_id text not null,
  phone_number_id text,
  field text not null,
  provider_message_id text,
  provider_status text,
  event_timestamp timestamptz,
  needs_review boolean not null default false,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists meta_webhook_items_pending_idx
  on public.meta_webhook_items (received_at, id) where processed_at is null;
create index if not exists meta_webhook_items_wamid_idx
  on public.meta_webhook_items (provider_message_id, event_timestamp)
  where kind = 'status' and provider_message_id is not null;
create index if not exists meta_webhook_items_review_idx
  on public.meta_webhook_items (received_at, id)
  where needs_review and processed_at is null;

-- A provider identity is retained even when it cannot yet be linked to a phone contact.
create table if not exists public.meta_opt_outs (
  id uuid primary key default gen_random_uuid(),
  waba_id text not null,
  phone_number_id text not null,
  identity_type text not null default 'whatsapp_from'
    check (identity_type = 'whatsapp_from'),
  identity_value text not null,
  source_item_key text not null check (source_item_key ~ '^[0-9a-f]{64}$'),
  source_message_id text,
  created_at timestamptz not null default now(),
  unique (waba_id, phone_number_id, identity_type, identity_value)
);

-- Until the provider identity is reconciled with a contact, outbound sends must honor this hold.
create table if not exists public.meta_sender_holds (
  waba_id text not null,
  phone_number_id text not null,
  reason text not null default 'unreconciled_opt_out'
    check (reason in ('unreconciled_opt_out', 'ambiguous_opt_out')),
  source_item_key text not null check (source_item_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (waba_id, phone_number_id)
);

-- A sender can have multiple unresolved ambiguous messages. Keep every source
-- until each one is reviewed; the hold cannot be cleared after just the latest.
create table if not exists public.meta_ambiguous_opt_out_events (
  source_item_key text primary key check (source_item_key ~ '^[0-9a-f]{64}$'),
  waba_id text not null,
  phone_number_id text not null,
  received_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists meta_ambiguous_opt_out_events_pending_idx
  on public.meta_ambiguous_opt_out_events (waba_id, phone_number_id, received_at)
  where reviewed_at is null;

-- A definite STOP can come from several customers while a sender is held.
-- Record each source, including events whose provider identity cannot yet be
-- mapped to a phone, before deciding whether the sender-wide hold may clear.
create table if not exists public.meta_confirmed_opt_out_events (
  source_item_key text primary key check (source_item_key ~ '^[0-9a-f]{64}$'),
  waba_id text not null,
  phone_number_id text not null,
  identity_value text,
  received_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists meta_confirmed_opt_out_events_pending_idx
  on public.meta_confirmed_opt_out_events (waba_id, phone_number_id, received_at)
  where reviewed_at is null;

-- Keep release evidence independently of inbox payload retention.
create table if not exists public.meta_sender_hold_reviews (
  id uuid primary key default gen_random_uuid(),
  waba_id text not null,
  phone_number_id text not null,
  source_item_key text not null check (source_item_key ~ '^[0-9a-f]{64}$'),
  reviewer_user_id uuid not null references auth.users(id),
  review_kind text not null default 'ambiguous_opt_out'
    check (review_kind in ('ambiguous_opt_out', 'unreconciled_opt_out')),
  recipient_e164 text check (recipient_e164 is null or recipient_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  review_reason text not null check (length(trim(review_reason)) between 10 and 1000),
  reviewed_at timestamptz not null default now(),
  unique (waba_id, phone_number_id, source_item_key)
);

create index if not exists meta_sender_hold_reviews_time_idx
  on public.meta_sender_hold_reviews (reviewed_at desc);

-- Older installs may have these foreign keys. Suppression evidence must survive
-- a later purge of raw inbox rows, so only the immutable digest is retained.
alter table public.meta_opt_outs
  drop constraint if exists meta_opt_outs_source_item_key_fkey;
alter table public.meta_sender_holds
  drop constraint if exists meta_sender_holds_source_item_key_fkey;

create table if not exists public.meta_test_sends (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id),
  waba_id text not null,
  phone_number_id text not null,
  recipient_e164 text not null check (recipient_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  template_name text not null check (length(trim(template_name)) > 0),
  template_language text not null check (length(trim(template_language)) > 0),
  state text not null default 'prepared'
    check (state in ('prepared', 'in_flight', 'accepted', 'rejected', 'uncertain')),
  wamid text unique,
  delivery_status text check (delivery_status in ('sent', 'delivered', 'read', 'failed')),
  delivery_conflict boolean not null default false,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_status_at timestamptz
);

create index if not exists meta_test_sends_created_idx
  on public.meta_test_sends (created_at desc);

-- Two tabs cannot start duplicate tests while a prior send is active or
-- accepted without a final delivery outcome. Uncertain sends remain parked.
create unique index if not exists meta_test_sends_open_recipient_idx
  on public.meta_test_sends (waba_id, phone_number_id, recipient_e164)
  where state in ('prepared', 'in_flight', 'uncertain')
     or (state = 'accepted' and coalesce(delivery_status, '') not in ('delivered', 'read', 'failed'));

create or replace function public.meta_test_send_updated_at()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists meta_test_send_updated_at_trigger on public.meta_test_sends;
create trigger meta_test_send_updated_at_trigger
before update on public.meta_test_sends
for each row execute function public.meta_test_send_updated_at();

-- Preserve the strongest successful status; surface success/failure contradictions.
create or replace function public.project_meta_test_send_status(
  p_waba_id text,
  p_phone_number_id text,
  p_wamid text,
  p_status text,
  p_event_at timestamptz
) returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_wamid is null or p_status not in ('sent', 'delivered', 'read', 'failed') then
    return;
  end if;

  -- Serialize projection with the wamid reconciliation trigger. Otherwise a
  -- concurrent webhook and send update can each miss the other's uncommitted row.
  perform pg_advisory_xact_lock(hashtextextended(p_wamid, 0));

  update public.meta_test_sends as send
  set state = case when send.state in ('prepared', 'in_flight', 'uncertain')
                   then 'accepted' else send.state end,
      delivery_conflict = send.delivery_conflict
        or send.state = 'rejected'
        or (send.delivery_status = 'failed' and p_status <> 'failed')
        or (send.delivery_status in ('sent', 'delivered', 'read') and p_status = 'failed'),
      delivery_status = case
        when send.delivery_status is null then p_status
        when send.delivery_status = 'failed' or p_status = 'failed' then send.delivery_status
        when case p_status when 'read' then 3 when 'delivered' then 2 else 1 end
           > case send.delivery_status when 'read' then 3 when 'delivered' then 2 else 1 end
          then p_status
        else send.delivery_status
      end,
      last_status_at = greatest(coalesce(send.last_status_at, '-infinity'::timestamptz),
                                coalesce(p_event_at, now()))
  where send.wamid = p_wamid
    and send.waba_id = p_waba_id
    and send.phone_number_id = p_phone_number_id;
end;
$$;

-- A status can reach the inbox before the send action has stored Meta's wamid.
create or replace function public.reconcile_meta_test_send_status()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare event_record record;
begin
  if new.wamid is null then return new; end if;
  if tg_op = 'UPDATE' then
    if new.wamid is not distinct from old.wamid then return new; end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.wamid, 0));

  for event_record in
    select waba_id, phone_number_id, provider_message_id, provider_status, event_timestamp
    from public.meta_webhook_items
    where kind = 'status' and provider_message_id = new.wamid
      and waba_id = new.waba_id and phone_number_id = new.phone_number_id
    order by coalesce(event_timestamp, received_at), received_at, id
  loop
    perform public.project_meta_test_send_status(
      event_record.waba_id, event_record.phone_number_id,
      event_record.provider_message_id, event_record.provider_status,
      event_record.event_timestamp
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists reconcile_meta_test_send_status_trigger on public.meta_test_sends;
create trigger reconcile_meta_test_send_status_trigger
after insert or update of wamid on public.meta_test_sends
for each row execute function public.reconcile_meta_test_send_status();

-- The send action records Meta's API outcome through this RPC. The shared lock
-- closes the race between an early webhook and a late wamid write.
create or replace function public.record_meta_test_send_result(
  p_id uuid,
  p_state text,
  p_wamid text,
  p_error_summary text
) returns public.meta_test_sends language plpgsql security definer
set search_path = public, pg_temp
as $$
declare result public.meta_test_sends;
begin
  if p_state not in ('accepted', 'rejected', 'uncertain')
     or (p_state = 'accepted' and nullif(p_wamid, '') is null)
     or (p_state <> 'accepted' and p_wamid is not null)
     or length(coalesce(p_error_summary, '')) > 500 then
    raise exception 'Invalid test send outcome';
  end if;

  if p_wamid is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  end if;

  update public.meta_test_sends
  set state = p_state,
      wamid = coalesce(p_wamid, wamid),
      error_summary = p_error_summary,
      finished_at = coalesce(finished_at, now())
  where id = p_id and state in ('prepared', 'in_flight', 'uncertain')
  returning * into result;
  if result.id is not null then return result; end if;

  select * into result from public.meta_test_sends where id = p_id;
  if result.id is null then raise exception 'Test send does not exist'; end if;
  if result.state = p_state and result.wamid is not distinct from p_wamid then
    return result;
  end if;
  raise exception 'Test send outcome cannot be changed';
end;
$$;

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

-- Each review clears one exact ambiguous source. Only the review of the last
-- pending source releases the sender hold. New inbound events take the same
-- hold row lock, so a concurrent STOP remains active after this transaction.
create or replace function public.release_meta_ambiguous_sender_hold(
  p_waba_id text,
  p_phone_number_id text,
  p_expected_source_item_key text,
  p_reviewer_user_id uuid,
  p_review_reason text
) returns public.meta_sender_holds language plpgsql security definer
set search_path = public, pg_temp
as $$
declare hold_record public.meta_sender_holds;
declare event_record public.meta_ambiguous_opt_out_events;
begin
  if nullif(trim(coalesce(p_waba_id, '')), '') is null
     or nullif(trim(coalesce(p_phone_number_id, '')), '') is null
     or p_expected_source_item_key is null
     or p_expected_source_item_key !~ '^[0-9a-f]{64}$'
     or p_reviewer_user_id is null
     or length(trim(coalesce(p_review_reason, ''))) not between 10 and 1000 then
    raise exception 'Invalid ambiguous hold review';
  end if;

  select * into hold_record from public.meta_sender_holds
  where waba_id = p_waba_id and phone_number_id = p_phone_number_id
  for update;
  if hold_record.waba_id is null or hold_record.released_at is not null
     or hold_record.reason <> 'ambiguous_opt_out' then
    raise exception 'Ambiguous hold is no longer active';
  end if;
  select * into event_record from public.meta_ambiguous_opt_out_events
  where source_item_key = p_expected_source_item_key
    and waba_id = p_waba_id and phone_number_id = p_phone_number_id
  for update;
  if event_record.source_item_key is null or event_record.reviewed_at is not null then
    raise exception 'Ambiguous source event changed or was already reviewed';
  end if;
  if not exists (
    select 1 from public.meta_webhook_items item
    where item.dedupe_key = p_expected_source_item_key
      and item.kind = 'message' and item.needs_review
      and item.waba_id = p_waba_id and item.phone_number_id = p_phone_number_id
      and item.payload <> '{}'::jsonb
  ) then
    raise exception 'Inbound review evidence is unavailable';
  end if;
  if exists (
    select 1 from public.meta_opt_outs opt_out
    where opt_out.source_item_key = p_expected_source_item_key
      and opt_out.waba_id = p_waba_id
      and opt_out.phone_number_id = p_phone_number_id
  ) then
    raise exception 'This source event is a confirmed opt-out';
  end if;

  insert into public.meta_sender_hold_reviews (
    waba_id, phone_number_id, source_item_key, reviewer_user_id, review_reason
  ) values (
    p_waba_id, p_phone_number_id, p_expected_source_item_key,
    p_reviewer_user_id, trim(p_review_reason)
  );
  update public.meta_webhook_items
  set needs_review = false
  where dedupe_key = p_expected_source_item_key;
  update public.meta_ambiguous_opt_out_events
  set reviewed_at = now()
  where source_item_key = p_expected_source_item_key;
  if not exists (
    select 1 from public.meta_ambiguous_opt_out_events event
    where event.waba_id = p_waba_id and event.phone_number_id = p_phone_number_id
      and event.reviewed_at is null
  ) and not exists (
    select 1 from public.meta_confirmed_opt_out_events event
    where event.waba_id = p_waba_id and event.phone_number_id = p_phone_number_id
      and event.reviewed_at is null
  ) then
    update public.meta_sender_holds
    set released_at = now()
    where waba_id = p_waba_id and phone_number_id = p_phone_number_id
    returning * into hold_record;
  elsif exists (
    select 1 from public.meta_confirmed_opt_out_events event
    where event.waba_id = p_waba_id and event.phone_number_id = p_phone_number_id
      and event.reviewed_at is null
  ) then
    update public.meta_sender_holds
    set reason = 'unreconciled_opt_out',
        source_item_key = (
          select event.source_item_key from public.meta_confirmed_opt_out_events event
          where event.waba_id = p_waba_id and event.phone_number_id = p_phone_number_id
            and event.reviewed_at is null
          order by event.received_at, event.source_item_key limit 1
        )
    where waba_id = p_waba_id and phone_number_id = p_phone_number_id
    returning * into hold_record;
  end if;
  return hold_record;
end;
$$;

-- A definite STOP suppresses its recipient permanently. Admin review only
-- removes the sender-wide precaution once that exact source has a usable
-- provider phone identity and a durable recipient-specific suppression.
create or replace function public.reconcile_meta_confirmed_sender_hold(
  p_waba_id text,
  p_phone_number_id text,
  p_expected_source_item_key text,
  p_reviewer_user_id uuid,
  p_recipient_e164 text,
  p_review_reason text
) returns public.meta_sender_holds language plpgsql security definer
set search_path = public, pg_temp
as $$
declare hold_record public.meta_sender_holds;
declare event_record public.meta_confirmed_opt_out_events;
declare expected_recipient text;
begin
  if nullif(trim(coalesce(p_waba_id, '')), '') is null
     or nullif(trim(coalesce(p_phone_number_id, '')), '') is null
     or p_expected_source_item_key is null
     or p_expected_source_item_key !~ '^[0-9a-f]{64}$'
     or p_reviewer_user_id is null
     or p_recipient_e164 is null
     or p_recipient_e164 !~ '^\+[1-9][0-9]{7,14}$'
     or length(trim(coalesce(p_review_reason, ''))) not between 10 and 1000 then
    raise exception 'Invalid confirmed opt-out reconciliation';
  end if;

  select * into hold_record from public.meta_sender_holds
  where waba_id = p_waba_id and phone_number_id = p_phone_number_id
  for update;
  if hold_record.waba_id is null or hold_record.released_at is not null
     or hold_record.reason <> 'unreconciled_opt_out' then
    raise exception 'Confirmed opt-out hold is no longer active';
  end if;
  select * into event_record from public.meta_confirmed_opt_out_events
  where source_item_key = p_expected_source_item_key
    and waba_id = p_waba_id and phone_number_id = p_phone_number_id
  for update;
  if event_record.source_item_key is null or event_record.reviewed_at is not null then
    raise exception 'Confirmed source event changed or was already reviewed';
  end if;
  if event_record.identity_value is null
     or event_record.identity_value !~ '^\+?[1-9][0-9]{7,14}$' then
    raise exception 'Confirmed source identity requires manual reconciliation';
  end if;
  expected_recipient := '+' || ltrim(event_record.identity_value, '+');
  if p_recipient_e164 <> expected_recipient then
    raise exception 'Recipient does not match provider identity';
  end if;
  if not exists (
    select 1 from public.meta_webhook_items item
    where item.dedupe_key = p_expected_source_item_key
      and item.kind = 'message' and item.needs_review
      and item.waba_id = p_waba_id and item.phone_number_id = p_phone_number_id
      and item.payload <> '{}'::jsonb
      and item.payload->>'from' = event_record.identity_value
  ) then
    raise exception 'Inbound STOP evidence is unavailable';
  end if;
  if not exists (
    select 1 from public.meta_opt_outs opt_out
    where opt_out.waba_id = p_waba_id and opt_out.phone_number_id = p_phone_number_id
      and opt_out.identity_type = 'whatsapp_from'
      and opt_out.identity_value = event_record.identity_value
  ) then
    raise exception 'Recipient-specific opt-out is not stored';
  end if;

  insert into public.meta_sender_hold_reviews (
    waba_id, phone_number_id, source_item_key, reviewer_user_id,
    review_kind, recipient_e164, review_reason
  ) values (
    p_waba_id, p_phone_number_id, p_expected_source_item_key,
    p_reviewer_user_id, 'unreconciled_opt_out', p_recipient_e164,
    trim(p_review_reason)
  );
  update public.meta_webhook_items
  set needs_review = false
  where dedupe_key = p_expected_source_item_key;
  update public.meta_confirmed_opt_out_events
  set reviewed_at = now()
  where source_item_key = p_expected_source_item_key;

  if exists (
    select 1 from public.meta_confirmed_opt_out_events event
    where event.waba_id = p_waba_id and event.phone_number_id = p_phone_number_id
      and event.reviewed_at is null
  ) then
    update public.meta_sender_holds
    set source_item_key = (
      select event.source_item_key from public.meta_confirmed_opt_out_events event
      where event.waba_id = p_waba_id and event.phone_number_id = p_phone_number_id
        and event.reviewed_at is null
      order by event.received_at, event.source_item_key limit 1
    )
    where waba_id = p_waba_id and phone_number_id = p_phone_number_id
    returning * into hold_record;
  elsif exists (
    select 1 from public.meta_ambiguous_opt_out_events event
    where event.waba_id = p_waba_id and event.phone_number_id = p_phone_number_id
      and event.reviewed_at is null
  ) then
    update public.meta_sender_holds
    set reason = 'ambiguous_opt_out',
        source_item_key = (
          select event.source_item_key from public.meta_ambiguous_opt_out_events event
          where event.waba_id = p_waba_id and event.phone_number_id = p_phone_number_id
            and event.reviewed_at is null
          order by event.received_at, event.source_item_key limit 1
        )
    where waba_id = p_waba_id and phone_number_id = p_phone_number_id
    returning * into hold_record;
  else
    update public.meta_sender_holds
    set released_at = now()
    where waba_id = p_waba_id and phone_number_id = p_phone_number_id
    returning * into hold_record;
  end if;
  return hold_record;
end;
$$;

-- Run from a reviewed retention schedule with the approved UTC cutoff. This
-- removes full envelope bodies and resolved/ordinary item bodies while keeping
-- hashes, status columns, suppressions, and unresolved review material.
create or replace function public.redact_meta_webhook_payloads(p_before timestamptz)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare envelope_count integer;
declare item_count integer;
begin
  if p_before is null or p_before >= now() then
    raise exception 'A past retention cutoff is required';
  end if;

  update public.meta_webhook_envelopes
  set raw_payload = null
  where received_at < p_before and raw_payload is not null;
  get diagnostics envelope_count = row_count;

  update public.meta_webhook_items
  set payload = '{}'::jsonb
  where received_at < p_before and payload <> '{}'::jsonb
    and not needs_review;
  get diagnostics item_count = row_count;

  return jsonb_build_object('envelopes_redacted', envelope_count,
                            'items_redacted', item_count);
end;
$$;

alter table public.meta_webhook_envelopes enable row level security;
alter table public.meta_webhook_items enable row level security;
alter table public.meta_opt_outs enable row level security;
alter table public.meta_sender_holds enable row level security;
alter table public.meta_ambiguous_opt_out_events enable row level security;
alter table public.meta_confirmed_opt_out_events enable row level security;
alter table public.meta_sender_hold_reviews enable row level security;
alter table public.meta_test_sends enable row level security;

revoke all on public.meta_webhook_envelopes, public.meta_webhook_items,
  public.meta_opt_outs, public.meta_sender_holds, public.meta_ambiguous_opt_out_events,
  public.meta_confirmed_opt_out_events,
  public.meta_sender_hold_reviews,
  public.meta_test_sends
  from public, anon, authenticated;
grant select, insert, update on public.meta_webhook_envelopes, public.meta_webhook_items,
  public.meta_opt_outs, public.meta_sender_holds
  to service_role;
grant select, insert on public.meta_ambiguous_opt_out_events to service_role;
grant select, insert on public.meta_confirmed_opt_out_events to service_role;
grant select, insert on public.meta_sender_hold_reviews to service_role;
grant select, insert on public.meta_test_sends to service_role;
grant update (state, error_summary, started_at, finished_at)
  on public.meta_test_sends to service_role;

revoke all on function public.receive_meta_whatsapp_webhook(text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.receive_meta_whatsapp_webhook(text, jsonb, jsonb, jsonb)
  to service_role;
revoke all on function public.release_meta_ambiguous_sender_hold(text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_meta_ambiguous_sender_hold(text, text, text, uuid, text)
  to service_role;
revoke all on function public.reconcile_meta_confirmed_sender_hold(text, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_meta_confirmed_sender_hold(text, text, text, uuid, text, text)
  to service_role;
revoke all on function public.record_meta_test_send_result(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_meta_test_send_result(uuid, text, text, text)
  to service_role;
revoke all on function public.redact_meta_webhook_payloads(timestamptz)
  from public, anon, authenticated;
grant execute on function public.redact_meta_webhook_payloads(timestamptz)
  to service_role;
revoke all on function public.project_meta_test_send_status(text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.reconcile_meta_test_send_status()
  from public, anon, authenticated;
revoke all on function public.meta_test_send_updated_at()
  from public, anon, authenticated;
