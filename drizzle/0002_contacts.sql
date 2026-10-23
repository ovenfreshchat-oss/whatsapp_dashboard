-- Contacts are imported without marketing eligibility. Only a reviewed, evidenced
-- grant can make them eligible, and every send must recheck this predicate.
create extension if not exists pgcrypto;

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text check (display_name is null or length(display_name) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.contact_import_batches (
  id uuid primary key default gen_random_uuid(),
  import_key uuid not null unique,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid not null references auth.users(id),
  file_name text not null check (length(file_name) between 1 and 255),
  file_kind text not null check (file_kind in ('csv', 'xlsx', 'docx')),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  total_rows integer not null default 0 check (total_rows between 0 and 5000),
  accepted_rows integer not null default 0 check (accepted_rows between 0 and 5000),
  rejected_rows integer not null default 0 check (rejected_rows between 0 and 5000),
  inserted_contacts integer not null default 0 check (inserted_contacts between 0 and 5000),
  existing_contacts integer not null default 0 check (existing_contacts between 0 and 5000),
  pending_claims integer not null default 0 check (pending_claims between 0 and 5000),
  negative_consent_rows integer not null default 0 check (negative_consent_rows between 0 and 5000),
  created_at timestamptz not null default now(),
  check (total_rows = accepted_rows + rejected_rows),
  check (accepted_rows = inserted_contacts + existing_contacts),
  check (negative_consent_rows <= accepted_rows)
);

create index if not exists contact_import_batches_created_idx
  on public.contact_import_batches (created_at desc);

create table if not exists public.contact_import_row_errors (
  batch_id uuid not null references public.contact_import_batches(id) on delete cascade,
  row_number integer not null check (row_number between 1 and 1048576),
  code text not null check (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  message text not null check (length(message) between 1 and 300),
  primary key (batch_id, row_number, code)
);

-- Pending imported claims do not count as opt-in. The source and exact notice
-- are supplied by a later admin review, only if evidence and timestamp exist.
create table if not exists public.contact_consent_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid unique,
  contact_id uuid not null references public.contacts(id),
  purpose text not null default 'whatsapp_marketing'
    check (purpose = 'whatsapp_marketing'),
  decision text not null check (decision in ('grant', 'revoke')),
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected')),
  source text check (source is null or length(source) between 1 and 200),
  notice_text text check (notice_text is null or length(notice_text) between 1 and 2000),
  evidence_reference text check (evidence_reference is null or length(evidence_reference) between 1 and 500),
  occurred_at timestamptz,
  -- Date-only evidence retains its original precision. occurred_at is the
  -- earliest possible instant for this calendar date (UTC+14 midnight).
  occurred_on date,
  import_batch_id uuid references public.contact_import_batches(id),
  import_row_number integer check (import_row_number between 1 and 1048576),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  recorded_at timestamptz not null default now(),
  check ((import_batch_id is null) = (import_row_number is null)),
  check (occurred_at is null or occurred_at <= recorded_at + interval '5 minutes'),
  check (occurred_on is null or
    (decision = 'grant' and import_batch_id is not null and occurred_at =
      (occurred_on::timestamp at time zone 'UTC') - interval '14 hours')),
  check (
    verification_status <> 'verified' or decision <> 'grant' or
    (source is not null and notice_text is not null and evidence_reference is not null
      and occurred_at is not null and reviewed_by is not null and reviewed_at is not null)
  ),
  check (decision <> 'revoke' or
    (verification_status = 'verified' and source is not null and occurred_at is not null
      and reviewed_by is not null and reviewed_at is not null))
);

create unique index if not exists contact_consent_import_row_idx
  on public.contact_consent_events (import_batch_id, import_row_number)
  where import_batch_id is not null;
create index if not exists contact_consent_latest_idx
  on public.contact_consent_events (contact_id, occurred_at desc, recorded_at desc, id desc)
  where verification_status = 'verified';

create table if not exists public.contact_marketing_suppressions (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  reason text not null check (reason in ('manual_opt_out', 'compliance_hold')),
  source text not null check (length(source) between 1 and 200),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  released_at timestamptz check (released_at is null or released_at >= created_at)
);

create index if not exists contact_marketing_suppressions_active_idx
  on public.contact_marketing_suppressions (phone_e164) where released_at is null;

create table if not exists public.contact_import_batch_reviews (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  batch_id uuid not null references public.contact_import_batches(id),
  reviewer_user_id uuid not null references auth.users(id),
  source text not null check (length(source) between 1 and 200),
  notice_text text not null check (length(notice_text) between 1 and 2000),
  reviewed_count integer not null check (reviewed_count between 0 and 5000),
  skipped_count integer not null check (skipped_count between 0 and 5000),
  created_at timestamptz not null default now()
);

-- A pending claim can only be resolved once. Its contact, evidence, timestamp,
-- and import provenance cannot be rewritten during review.
create or replace function public.guard_contact_consent_event_update()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.verification_status <> 'pending'
     or new.verification_status not in ('verified', 'rejected')
     or new.id is distinct from old.id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.contact_id is distinct from old.contact_id
     or new.purpose is distinct from old.purpose
     or new.decision is distinct from old.decision
     or new.evidence_reference is distinct from old.evidence_reference
     or new.occurred_at is distinct from old.occurred_at
     or new.occurred_on is distinct from old.occurred_on
     or new.import_batch_id is distinct from old.import_batch_id
     or new.import_row_number is distinct from old.import_row_number
     or new.recorded_at is distinct from old.recorded_at
     or old.source is not null or old.notice_text is not null
     or new.reviewed_by is null or new.reviewed_at is null then
    raise exception 'Consent event history cannot be rewritten';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_contact_consent_event_update_trigger on public.contact_consent_events;
create trigger guard_contact_consent_event_update_trigger
before update on public.contact_consent_events
for each row execute function public.guard_contact_consent_event_update();

create or replace function public.guard_contact_consent_event_delete()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Consent event history cannot be deleted';
end;
$$;

drop trigger if exists guard_contact_consent_event_delete_trigger on public.contact_consent_events;
create trigger guard_contact_consent_event_delete_trigger
before delete on public.contact_consent_events
for each row execute function public.guard_contact_consent_event_delete();

-- The verified event with the latest occurrence time wins; a revoke wins a tie.
-- Importing an old grant after a newer revoke cannot restore eligibility.
create or replace function public.can_send_whatsapp_marketing(
  p_contact_id uuid,
  p_waba_id text,
  p_phone_number_id text
) returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    p_waba_id is not null and length(p_waba_id) > 0
    and p_phone_number_id is not null and length(p_phone_number_id) > 0
    and exists (
      select 1 from public.contacts c
      where c.id = p_contact_id
        and (
          select event.decision
          from public.contact_consent_events event
          where event.contact_id = c.id
            and event.purpose = 'whatsapp_marketing'
            and event.verification_status = 'verified'
            and event.occurred_at <= now()
          order by event.occurred_at desc,
                   (event.decision = 'revoke') desc,
                   event.recorded_at desc, event.id desc
          limit 1
        ) = 'grant'
        and not exists (
          select 1 from public.contact_marketing_suppressions suppression
          where suppression.phone_e164 = c.phone_e164
            and suppression.released_at is null
        )
        and not exists (
          select 1 from public.meta_opt_outs opt_out
          where opt_out.waba_id = p_waba_id
            and opt_out.phone_number_id = p_phone_number_id
            and opt_out.identity_type = 'whatsapp_from'
            and opt_out.identity_value in (c.phone_e164, substring(c.phone_e164 from 2))
        )
        and not exists (
          select 1 from public.meta_sender_holds hold
          where hold.waba_id = p_waba_id
            and hold.phone_number_id = p_phone_number_id
            and hold.released_at is null
        )
    ), false);
$$;

-- One transaction per uploaded file, including contacts, pending claims, and
-- row errors. The caller must reparse the file on commit and authorize the actor.
create or replace function public.import_contact_batch(
  p_import_key uuid,
  p_actor_user_id uuid,
  p_file_name text,
  p_file_kind text,
  p_file_sha256 text,
  p_rows jsonb,
  p_errors jsonb
) returns jsonb language plpgsql security definer
-- Supabase installs pgcrypto in extensions; plain PostgreSQL may use public.
set search_path = extensions, public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_existing public.contact_import_batches;
  v_request_sha256 text;
  v_row jsonb;
  v_error jsonb;
  v_contact_id uuid;
  v_phone text;
  v_name text;
  v_row_number integer;
  v_claimed boolean;
  v_explicit_no boolean;
  v_evidence text;
  v_occurred_text text;
  v_occurred_on_text text;
  v_occurred timestamptz;
  v_occurred_on date;
  v_inserted integer := 0;
  v_existing_contacts integer := 0;
  v_claims integer := 0;
  v_negative_rows integer := 0;
  v_rejected integer := 0;
  v_seen_phones text[] := array[]::text[];
  v_seen_rows integer[] := array[]::integer[];
  v_error_rows integer[] := array[]::integer[];
begin
  if p_import_key is null or p_actor_user_id is null
     or p_file_name is null or length(trim(p_file_name)) not between 1 and 255
     or position('/' in p_file_name) > 0 or position(chr(92) in p_file_name) > 0
     or p_file_kind is null or p_file_kind not in ('csv', 'xlsx', 'docx')
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_typeof(p_errors) is distinct from 'array' then
    raise exception 'Invalid contact import batch';
  end if;
  if jsonb_array_length(p_rows) + jsonb_array_length(p_errors) > 15000
     or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Contact import exceeds row limit';
  end if;
  v_request_sha256 := encode(digest(jsonb_build_object(
    'actor', p_actor_user_id, 'name', p_file_name, 'kind', p_file_kind,
    'file', p_file_sha256, 'rows', p_rows, 'errors', p_errors
  )::text, 'sha256'), 'hex');

  insert into public.contact_import_batches (
    import_key, request_sha256, actor_user_id, file_name, file_kind, file_sha256
  ) values (
    p_import_key, v_request_sha256, p_actor_user_id, p_file_name, p_file_kind, p_file_sha256
  ) on conflict (import_key) do nothing returning id into v_batch_id;
  if v_batch_id is null then
    select * into v_existing from public.contact_import_batches where import_key = p_import_key;
    if v_existing.request_sha256 is distinct from v_request_sha256 then
      raise exception 'Contact import key reused with different content';
    end if;
    return jsonb_build_object(
      'batch_id', v_existing.id, 'inserted', v_existing.inserted_contacts,
      'existing', v_existing.existing_contacts, 'consent_claims', v_existing.pending_claims,
      'negative_consent_rows', v_existing.negative_consent_rows,
      'rejected_rows', v_existing.rejected_rows
    );
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) is distinct from 'object'
       or jsonb_typeof(v_row->'row_number') is distinct from 'number'
       or jsonb_typeof(v_row->'phone_e164') is distinct from 'string'
       or (v_row ? 'consent_claimed' and jsonb_typeof(v_row->'consent_claimed') is distinct from 'boolean')
       or (v_row ? 'consent_explicit_no' and jsonb_typeof(v_row->'consent_explicit_no') is distinct from 'boolean') then
      raise exception 'Invalid contact import row';
    end if;
    v_row_number := (v_row->>'row_number')::integer;
    v_phone := v_row->>'phone_e164';
    v_name := nullif(trim(v_row->>'display_name'), '');
    v_claimed := coalesce((v_row->>'consent_claimed')::boolean, false);
    v_explicit_no := coalesce((v_row->>'consent_explicit_no')::boolean, false);
    v_evidence := nullif(trim(v_row->>'evidence_reference'), '');
    v_occurred_text := nullif(v_row->>'consent_occurred_at', '');
    v_occurred_on_text := nullif(v_row->>'consent_occurred_on', '');
    if v_occurred_text is not null and
       v_occurred_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' then
      raise exception 'Consent occurrence time needs an explicit timezone';
    end if;
    v_occurred := v_occurred_text::timestamptz;
    v_occurred_on := null;
    if v_occurred_on_text is not null then
      if v_occurred_on_text !~ '^\d{4}-\d{2}-\d{2}$'
         or not v_claimed then
        raise exception 'Invalid date-only consent evidence';
      end if;
      v_occurred_on := v_occurred_on_text::date;
      if v_occurred_on > (now() at time zone 'UTC')::date
         or v_occurred is distinct from
           (v_occurred_on::timestamp at time zone 'UTC') - interval '14 hours' then
        raise exception 'Date-only consent needs its conservative UTC bound';
      end if;
    end if;
    if v_row_number not between 2 and 1048576 or v_row_number = any(v_seen_rows)
       or v_phone !~ '^\+[1-9][0-9]{7,14}$' or v_phone = any(v_seen_phones)
       or (v_claimed and v_explicit_no)
       or length(coalesce(v_name, '')) > 160
       or length(coalesce(v_evidence, '')) > 500
       or (v_occurred is not null and v_occurred > now() + interval '5 minutes') then
      raise exception 'Invalid or duplicate contact import row';
    end if;
    v_seen_rows := array_append(v_seen_rows, v_row_number);
    v_seen_phones := array_append(v_seen_phones, v_phone);
    insert into public.contacts (phone_e164, display_name)
    values (v_phone, v_name)
    on conflict (phone_e164) do nothing returning id into v_contact_id;
    if v_contact_id is null then
      select id into v_contact_id from public.contacts where phone_e164 = v_phone;
      v_existing_contacts := v_existing_contacts + 1;
    else
      v_inserted := v_inserted + 1;
    end if;
    if v_claimed then
      insert into public.contact_consent_events (
        contact_id, decision, verification_status, evidence_reference,
        occurred_at, occurred_on, import_batch_id, import_row_number
      ) values (
        v_contact_id, 'grant', 'pending', v_evidence,
        v_occurred, v_occurred_on, v_batch_id, v_row_number
      );
      v_claims := v_claims + 1;
    end if;
    if v_explicit_no then
      -- A negative value on an accepted row immediately blocks an older grant.
      -- Repeated negative imports refresh the hold time. A current manual opt-out
      -- stays manual and cannot be released by later evidence review.
      insert into public.contact_marketing_suppressions (
        phone_e164, reason, source, created_by
      ) values (
        v_phone, 'compliance_hold',
        'contact import ' || v_batch_id::text || ' row ' || v_row_number::text,
        p_actor_user_id
      ) on conflict (phone_e164) do update
        set reason = 'compliance_hold', source = excluded.source,
            created_by = excluded.created_by, created_at = excluded.created_at,
            released_at = null
        where public.contact_marketing_suppressions.reason <> 'manual_opt_out'
           or public.contact_marketing_suppressions.released_at is not null;
      v_negative_rows := v_negative_rows + 1;
    end if;
  end loop;

  for v_error in select value from jsonb_array_elements(p_errors) loop
    if jsonb_typeof(v_error) is distinct from 'object'
       or jsonb_typeof(v_error->'row_number') is distinct from 'number'
       or jsonb_typeof(v_error->'code') is distinct from 'string'
       or jsonb_typeof(v_error->'message') is distinct from 'string' then
      raise exception 'Invalid contact import error';
    end if;
    v_row_number := (v_error->>'row_number')::integer;
    if v_row_number not between 2 and 1048576 or v_row_number = any(v_seen_rows)
       or (v_error->>'code') !~ '^[a-z][a-z0-9_]{0,63}$'
       or length(v_error->>'message') not between 1 and 300 then
      raise exception 'Invalid contact import error';
    end if;
    if v_row_number <> all(v_error_rows) then
      v_error_rows := array_append(v_error_rows, v_row_number);
      v_rejected := v_rejected + 1;
    end if;
    insert into public.contact_import_row_errors (batch_id, row_number, code, message)
    values (v_batch_id, v_row_number, v_error->>'code', v_error->>'message')
    on conflict (batch_id, row_number, code) do nothing;
  end loop;
  if jsonb_array_length(p_rows) + v_rejected > 5000 then
    raise exception 'Contact import exceeds row limit';
  end if;
  update public.contact_import_batches
  set total_rows = jsonb_array_length(p_rows) + v_rejected,
      accepted_rows = jsonb_array_length(p_rows), rejected_rows = v_rejected,
      inserted_contacts = v_inserted, existing_contacts = v_existing_contacts,
       pending_claims = v_claims, negative_consent_rows = v_negative_rows
  where id = v_batch_id;
  return jsonb_build_object(
    'batch_id', v_batch_id, 'inserted', v_inserted, 'existing', v_existing_contacts,
    'consent_claims', v_claims, 'negative_consent_rows', v_negative_rows,
    'rejected_rows', v_rejected
  );
end;
$$;

-- Only a verified grant that occurred after an imported No can release that
-- import hold. Manual opt-outs are never released by this helper.
create or replace function public.release_import_consent_hold(p_event_id uuid)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  update public.contact_marketing_suppressions suppression
  set released_at = now()
  from public.contacts contact, public.contact_consent_events event
  where event.id = p_event_id
    and event.contact_id = contact.id
    and event.decision = 'grant'
    and event.verification_status = 'verified'
    and event.occurred_at <= now()
    and suppression.phone_e164 = contact.phone_e164
    and suppression.reason = 'compliance_hold'
    and suppression.released_at is null
    and event.occurred_at > suppression.created_at;
end;
$$;

-- A single imported claim may be reviewed without approving its entire batch.
-- It remains pending if evidence or a timezone-qualified occurrence time is
-- missing. The caller has already authenticated and authorized the reviewer.
create or replace function public.review_imported_consent_claim(
  p_event_id uuid,
  p_reviewer_user_id uuid,
  p_source text,
  p_notice_text text,
  p_decision text
) returns public.contact_consent_events language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.contact_consent_events;
  v_status text;
begin
  if p_event_id is null or p_reviewer_user_id is null
     or p_decision is null or p_decision not in ('grant', 'reject')
     or p_source is null or length(trim(p_source)) not between 1 and 200
     or (p_decision = 'grant' and
       (p_notice_text is null or length(trim(p_notice_text)) not between 1 and 2000))
     or (p_notice_text is not null and length(trim(p_notice_text)) > 2000) then
    raise exception 'Invalid imported consent review';
  end if;
  v_status := case when p_decision = 'grant' then 'verified' else 'rejected' end;
  select * into v_event from public.contact_consent_events
  where id = p_event_id for update;
  if v_event.id is null or v_event.import_batch_id is null
     or v_event.decision <> 'grant' then
    raise exception 'Imported consent claim does not exist';
  end if;
  if v_event.verification_status <> 'pending' then
    if v_event.verification_status = v_status
       and v_event.reviewed_by is not distinct from p_reviewer_user_id
       and v_event.source is not distinct from trim(p_source)
       and v_event.notice_text is not distinct from nullif(trim(p_notice_text), '') then
      return v_event;
    end if;
    raise exception 'Imported consent claim was already reviewed';
  end if;
  if p_decision = 'grant' and
     (v_event.evidence_reference is null or v_event.occurred_at is null
       or v_event.occurred_at > now()
       or (v_event.occurred_on is not null and now() <
          ((v_event.occurred_on + 1)::timestamp at time zone 'UTC') + interval '12 hours')) then
    raise exception 'Imported consent claim lacks evidence or occurrence time';
  end if;
  update public.contact_consent_events
  set verification_status = v_status,
      source = trim(p_source), notice_text = nullif(trim(p_notice_text), ''),
      reviewed_by = p_reviewer_user_id, reviewed_at = now()
  where id = p_event_id returning * into v_event;
  if p_decision = 'grant' then
    perform public.release_import_consent_hold(v_event.id);
  end if;
  return v_event;
end;
$$;

-- Admin review of a single person's evidence. A verified grant creates a new
-- immutable event; an imported claim stays as provenance for its own batch.
create or replace function public.record_contact_consent(
  p_idempotency_key uuid,
  p_contact_id uuid,
  p_decision text,
  p_source text,
  p_notice_text text,
  p_evidence_reference text,
  p_occurred_at timestamptz,
  p_reviewer_user_id uuid
) returns public.contact_consent_events language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_result public.contact_consent_events;
  v_phone text;
begin
  if p_idempotency_key is null or p_contact_id is null or p_reviewer_user_id is null
     or p_decision is null or p_decision not in ('grant', 'revoke')
     or p_source is null or length(trim(p_source)) not between 1 and 200
     or p_occurred_at is null or p_occurred_at > now() + interval '5 minutes'
     or (p_decision = 'grant' and
       (p_notice_text is null or length(trim(p_notice_text)) not between 1 and 2000
        or p_evidence_reference is null or length(trim(p_evidence_reference)) not between 1 and 500)) then
    raise exception 'Consent evidence is incomplete';
  end if;
  select phone_e164 into v_phone from public.contacts where id = p_contact_id;
  if v_phone is null then raise exception 'Contact does not exist'; end if;

  insert into public.contact_consent_events (
    idempotency_key, contact_id, decision, verification_status,
    source, notice_text, evidence_reference, occurred_at,
    reviewed_by, reviewed_at
  ) values (
    p_idempotency_key, p_contact_id, p_decision, 'verified',
    trim(p_source), nullif(trim(p_notice_text), ''),
    nullif(trim(p_evidence_reference), ''), p_occurred_at,
    p_reviewer_user_id, now()
  ) on conflict (idempotency_key) do nothing returning * into v_result;
  if v_result.id is null then
    select * into v_result from public.contact_consent_events
    where idempotency_key = p_idempotency_key;
    if v_result.contact_id is distinct from p_contact_id
       or v_result.decision is distinct from p_decision
       or v_result.source is distinct from trim(p_source)
       or v_result.notice_text is distinct from nullif(trim(p_notice_text), '')
       or v_result.evidence_reference is distinct from nullif(trim(p_evidence_reference), '')
       or v_result.occurred_at is distinct from p_occurred_at
       or v_result.reviewed_by is distinct from p_reviewer_user_id then
      raise exception 'Consent key reused with different content';
    end if;
    return v_result;
  end if;
  if p_decision = 'revoke' then
    insert into public.contact_marketing_suppressions (
      phone_e164, reason, source, created_by
    ) values (
      v_phone, 'manual_opt_out', trim(p_source), p_reviewer_user_id
    ) on conflict (phone_e164) do update
      set reason = 'manual_opt_out', source = excluded.source,
          created_by = excluded.created_by, released_at = null;
  else
    perform public.release_import_consent_hold(v_result.id);
  end if;
  return v_result;
end;
$$;

-- One deliberate review can verify all evidenced claims in a particular import.
-- Claims lacking per-person evidence or occurrence time remain pending.
create or replace function public.review_imported_consent_batch(
  p_batch_id uuid,
  p_reviewer_user_id uuid,
  p_source text,
  p_notice_text text,
  p_idempotency_key uuid
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_review public.contact_import_batch_reviews;
  v_reviewed integer;
  v_skipped integer;
  v_event_id uuid;
begin
  if p_batch_id is null or p_reviewer_user_id is null or p_idempotency_key is null
     or p_source is null or length(trim(p_source)) not between 1 and 200
     or p_notice_text is null or length(trim(p_notice_text)) not between 1 and 2000 then
    raise exception 'Batch review needs source and exact notice text';
  end if;
  -- Serialize same-batch reviews before checking idempotency.
  perform 1 from public.contact_import_batches where id = p_batch_id for update;
  if not found then raise exception 'Import batch does not exist'; end if;
  select * into v_review from public.contact_import_batch_reviews
  where idempotency_key = p_idempotency_key;
  if v_review.id is not null then
    if v_review.batch_id is distinct from p_batch_id
       or v_review.reviewer_user_id is distinct from p_reviewer_user_id
       or v_review.source is distinct from trim(p_source)
       or v_review.notice_text is distinct from trim(p_notice_text) then
      raise exception 'Batch review key reused with different content';
    end if;
    return jsonb_build_object('batch_id', p_batch_id,
      'reviewed', v_review.reviewed_count, 'skipped', v_review.skipped_count);
  end if;
  -- The second reviewer sees events resolved by the first transaction.
  update public.contact_consent_events
  set verification_status = 'verified', source = trim(p_source),
      notice_text = trim(p_notice_text), reviewed_by = p_reviewer_user_id,
      reviewed_at = now()
  where import_batch_id = p_batch_id
    and decision = 'grant' and verification_status = 'pending'
    and evidence_reference is not null and occurred_at is not null
    and occurred_at <= now()
    and (occurred_on is null or now() >=
      ((occurred_on + 1)::timestamp at time zone 'UTC') + interval '12 hours');
  get diagnostics v_reviewed = row_count;
  for v_event_id in
    select id from public.contact_consent_events
    where import_batch_id = p_batch_id and decision = 'grant'
      and verification_status = 'verified' and reviewed_by = p_reviewer_user_id
  loop
    perform public.release_import_consent_hold(v_event_id);
  end loop;
  select count(*) into v_skipped from public.contact_consent_events
  where import_batch_id = p_batch_id and verification_status = 'pending';
  insert into public.contact_import_batch_reviews (
    idempotency_key, batch_id, reviewer_user_id,
    source, notice_text, reviewed_count, skipped_count
  ) values (
    p_idempotency_key, p_batch_id, p_reviewer_user_id,
    trim(p_source), trim(p_notice_text), v_reviewed, v_skipped
  );
  return jsonb_build_object('batch_id', p_batch_id,
    'reviewed', v_reviewed, 'skipped', v_skipped);
end;
$$;

alter table public.contacts enable row level security;
alter table public.contact_import_batches enable row level security;
alter table public.contact_import_row_errors enable row level security;
alter table public.contact_consent_events enable row level security;
alter table public.contact_marketing_suppressions enable row level security;
alter table public.contact_import_batch_reviews enable row level security;

revoke all on public.contacts, public.contact_import_batches,
  public.contact_import_row_errors, public.contact_consent_events,
  public.contact_marketing_suppressions, public.contact_import_batch_reviews
  from public, anon, authenticated;
grant select on public.contacts, public.contact_import_batches,
  public.contact_import_row_errors, public.contact_consent_events,
  public.contact_marketing_suppressions, public.contact_import_batch_reviews
  to service_role;
grant insert on public.contacts, public.contact_import_batches,
  public.contact_import_row_errors, public.contact_consent_events,
  public.contact_marketing_suppressions, public.contact_import_batch_reviews
  to service_role;
grant update (display_name, updated_at) on public.contacts to service_role;
grant update (released_at) on public.contact_marketing_suppressions to service_role;

revoke all on function public.can_send_whatsapp_marketing(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.import_contact_batch(uuid, uuid, text, text, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.record_contact_consent(uuid, uuid, text, text, text, text, timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function public.review_imported_consent_batch(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.review_imported_consent_claim(uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.guard_contact_consent_event_update(),
  public.guard_contact_consent_event_delete(),
  public.release_import_consent_hold(uuid)
  from public, anon, authenticated;
revoke all on function public.release_import_consent_hold(uuid)
  from service_role;
grant execute on function public.can_send_whatsapp_marketing(uuid, text, text)
  to service_role;
grant execute on function public.import_contact_batch(uuid, uuid, text, text, text, jsonb, jsonb)
  to service_role;
grant execute on function public.record_contact_consent(uuid, uuid, text, text, text, text, timestamptz, uuid)
  to service_role;
grant execute on function public.review_imported_consent_batch(uuid, uuid, text, text, uuid)
  to service_role;
grant execute on function public.review_imported_consent_claim(uuid, uuid, text, text, text)
  to service_role;
