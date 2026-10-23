-- Apply after 0001_meta_webhook_inbox.sql and 0002_contacts.sql.
-- Campaigns never send from a database function or a web request. A separately
-- enabled worker claims bounded rows, checks current eligibility, then calls Meta.

-- Resolve pgcrypto.digest in either Supabase's extensions schema or public.
-- The generated expression stores the resolved function, so this only needs
-- to cover table creation.
set search_path = extensions, public, pg_temp;
create table if not exists public.whatsapp_campaigns (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id),
  name text not null check (length(trim(name)) between 1 and 120),
  audience_source text not null check (audience_source in ('import_batch', 'all_eligible')),
  import_batch_id uuid references public.contact_import_batches(id),
  audience_source_label text not null check (length(audience_source_label) between 1 and 255),
  check ((audience_source = 'import_batch' and import_batch_id is not null)
      or (audience_source = 'all_eligible' and import_batch_id is null)),
  waba_id text not null,
  phone_number_id text not null,
  template_id text not null,
  template_name text not null,
  template_language text not null,
  template_snapshot jsonb not null check (jsonb_typeof(template_snapshot) = 'object'),
  body_parameters jsonb not null default '[]'::jsonb
    check (jsonb_typeof(body_parameters) = 'array'),
  review_sha256 text generated always as (
    encode(digest(template_snapshot::text || E'\n' || body_parameters::text,
                  'sha256'), 'hex')
  ) stored,
  state text not null default 'draft'
    check (state in ('draft', 'scheduled', 'running', 'paused', 'canceled', 'completed')),
  scheduled_for timestamptz,
  audience_count integer not null default 0 check (audience_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
reset search_path;

create index if not exists whatsapp_campaigns_due_idx
  on public.whatsapp_campaigns (scheduled_for, id) where state = 'scheduled';
create index if not exists whatsapp_campaigns_created_idx
  on public.whatsapp_campaigns (created_at desc);

create table if not exists public.whatsapp_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.whatsapp_campaigns(id),
  contact_id uuid not null references public.contacts(id),
  consent_event_id uuid references public.contact_consent_events(id),
  recipient_e164 text not null check (recipient_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  state text not null default 'pending'
    check (state in ('pending', 'in_flight', 'accepted', 'rejected', 'uncertain',
                    'suppressed', 'canceled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  wamid text unique,
  delivery_status text check (delivery_status in ('sent', 'delivered', 'read', 'failed')),
  delivery_conflict boolean not null default false,
  last_status_at timestamptz,
  claimed_at timestamptz,
  finished_at timestamptz,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);

create index if not exists whatsapp_campaign_recipients_pending_idx
  on public.whatsapp_campaign_recipients (campaign_id, created_at, id)
  where state = 'pending';
create index if not exists whatsapp_campaign_recipients_inflight_idx
  on public.whatsapp_campaign_recipients (claimed_at, id)
  where state = 'in_flight';

create table if not exists public.whatsapp_campaign_send_attempts (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.whatsapp_campaign_recipients(id),
  attempt_number integer not null check (attempt_number > 0),
  state text not null check (state in ('in_flight', 'accepted', 'rejected', 'uncertain')),
  wamid text unique,
  error_summary text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (recipient_id, attempt_number)
);

create table if not exists public.whatsapp_campaign_audit (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.whatsapp_campaigns(id),
  actor_user_id uuid references auth.users(id),
  action text not null check (action in ('create', 'schedule', 'start', 'pause', 'resume',
                                         'cancel', 'complete', 'worker_pause')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_campaign_audit_time_idx
  on public.whatsapp_campaign_audit (campaign_id, created_at desc);

-- A database-wide per-sender slot keeps multiple worker processes under the
-- configured ceiling. This is an operational ceiling, not a Meta allowance.
create table if not exists public.whatsapp_sender_rate_slots (
  waba_id text not null,
  phone_number_id text not null,
  next_available_at timestamptz not null,
  primary key (waba_id, phone_number_id)
);

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
  select campaign.id, contact.id, consent.id, contact.phone_e164
  from public.contacts as contact
  left join lateral (
    select event.id
    from public.contact_consent_events as event
    where event.contact_id = contact.id
      and event.purpose = 'whatsapp_marketing'
      and event.decision = 'grant'
      and event.verification_status = 'verified'
      and (p_all_eligible or event.import_batch_id = p_import_batch_id)
    order by event.occurred_at desc, event.recorded_at desc, event.id desc
    limit 1
  ) as consent on true
  where consent.id is not null
    and contact.phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
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

create or replace function public.transition_whatsapp_campaign(
  p_campaign_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_scheduled_for timestamptz default null,
  p_review_acknowledged boolean default false,
  p_expected_audience_count integer default null,
  p_expected_review_sha256 text default null
) returns public.whatsapp_campaigns language plpgsql security definer
set search_path = public, pg_temp
as $$
declare campaign public.whatsapp_campaigns;
begin
  select * into campaign from public.whatsapp_campaigns
  where id = p_campaign_id for update;
  if campaign.id is null or p_actor_user_id is null then
    raise exception 'Campaign not found or actor missing';
  end if;

  if p_action = 'schedule' then
    if campaign.state <> 'draft' or p_scheduled_for is null
       or p_scheduled_for <= now() or campaign.audience_count = 0 then
      raise exception 'Campaign cannot be scheduled';
    end if;
    if p_review_acknowledged is distinct from true
       or p_expected_audience_count is distinct from campaign.audience_count
       or p_expected_review_sha256 is distinct from campaign.review_sha256 then
      raise exception 'Campaign review is missing or stale';
    end if;
    -- The frozen audience can only shrink after consent or phone changes.
    update public.whatsapp_campaign_recipients as recipient
    set state = 'suppressed', finished_at = now(), updated_at = now(),
        error_summary = 'Recipient no longer eligible at schedule time'
    where recipient.campaign_id = campaign.id and recipient.state = 'pending'
      and not public.whatsapp_campaign_recipient_eligible(recipient.id);
    if not exists (
      select 1 from public.whatsapp_campaign_recipients
      where campaign_id = campaign.id and state = 'pending'
    ) then
      raise exception 'Campaign has no eligible recipients';
    end if;
    update public.whatsapp_campaigns set state = 'scheduled',
      scheduled_for = p_scheduled_for, updated_at = now()
    where id = campaign.id returning * into campaign;
  elsif p_action = 'pause' then
    if campaign.state not in ('scheduled', 'running') then
      raise exception 'Campaign cannot be paused';
    end if;
    update public.whatsapp_campaigns set state = 'paused', updated_at = now()
    where id = campaign.id returning * into campaign;
  elsif p_action = 'resume' then
    if campaign.state <> 'paused' then raise exception 'Campaign cannot be resumed'; end if;
    update public.whatsapp_campaigns
    set state = case when scheduled_for > now() then 'scheduled' else 'running' end,
        updated_at = now()
    where id = campaign.id returning * into campaign;
  elsif p_action = 'cancel' then
    if campaign.state in ('canceled', 'completed') then
      raise exception 'Campaign cannot be canceled';
    end if;
    update public.whatsapp_campaigns set state = 'canceled', updated_at = now()
    where id = campaign.id returning * into campaign;
    update public.whatsapp_campaign_recipients
    set state = 'canceled', finished_at = now(), updated_at = now()
    where campaign_id = campaign.id and state = 'pending';
  else
    raise exception 'Unknown campaign action';
  end if;

  insert into public.whatsapp_campaign_audit (campaign_id, actor_user_id, action,
                                               detail)
  values (campaign.id, p_actor_user_id, p_action,
          case when p_action = 'schedule'
               then jsonb_build_object(
                 'scheduled_for', p_scheduled_for,
                 'review_acknowledged', true,
                 'review_audience_count', p_expected_audience_count,
                 'review_sha256', p_expected_review_sha256,
                 'audience_source', campaign.audience_source,
                 'import_batch_id', campaign.import_batch_id,
                 'audience_source_label', campaign.audience_source_label)
               else '{}'::jsonb end);
  return campaign;
end;
$$;

-- Exact destination matching ensures a contact phone edit cannot redirect a
-- previously reviewed campaign. The consent RPC also checks sender holds.
create or replace function public.whatsapp_campaign_recipient_eligible(p_recipient_id uuid)
returns boolean language sql security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select contact.phone_e164 = recipient.recipient_e164
      and public.can_send_whatsapp_marketing(
        recipient.contact_id, campaign.waba_id, campaign.phone_number_id
      )
    from public.whatsapp_campaign_recipients as recipient
    join public.whatsapp_campaigns as campaign on campaign.id = recipient.campaign_id
    join public.contacts as contact on contact.id = recipient.contact_id
    where recipient.id = p_recipient_id
  ), false);
$$;

create or replace function public.whatsapp_campaign_send_gate(p_recipient_id uuid)
returns text language plpgsql security definer
set search_path = public, pg_temp
as $$
declare campaign_state text;
declare recipient_state text;
begin
  select campaign.state, recipient.state into campaign_state, recipient_state
  from public.whatsapp_campaign_recipients as recipient
  join public.whatsapp_campaigns as campaign on campaign.id = recipient.campaign_id
  where recipient.id = p_recipient_id;
  if recipient_state <> 'in_flight' or recipient_state is null then return 'inactive'; end if;
  if campaign_state = 'canceled' then return 'canceled'; end if;
  if campaign_state <> 'running' then return 'deferred'; end if;
  if not public.whatsapp_campaign_recipient_eligible(p_recipient_id) then
    return 'suppressed';
  end if;
  return 'allowed';
end;
$$;

create or replace function public.worker_pause_whatsapp_campaign(
  p_campaign_id uuid, p_reason text
) returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_campaign_id is null or length(coalesce(p_reason, '')) > 120 then
    raise exception 'Invalid worker pause';
  end if;
  update public.whatsapp_campaigns
  set state = 'paused', updated_at = now()
  where id = p_campaign_id and state in ('scheduled', 'running');
  if found then
    insert into public.whatsapp_campaign_audit (campaign_id, action, detail)
    values (p_campaign_id, 'worker_pause', jsonb_build_object('reason', p_reason));
  end if;
end;
$$;

create or replace function public.claim_whatsapp_campaign_recipients(p_limit integer)
returns setof public.whatsapp_campaign_recipients language plpgsql security definer
set search_path = public, pg_temp
as $$
declare claimed public.whatsapp_campaign_recipients;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'Invalid campaign claim limit';
  end if;

  with started as (
    update public.whatsapp_campaigns
    set state = 'running', updated_at = now()
    where state = 'scheduled' and scheduled_for <= now()
    returning id
  )
  insert into public.whatsapp_campaign_audit (campaign_id, action)
  select id, 'start' from started;

  for claimed in
    with chosen as (
      select recipient.id
      from public.whatsapp_campaign_recipients as recipient
      join public.whatsapp_campaigns as campaign on campaign.id = recipient.campaign_id
      where recipient.state = 'pending' and campaign.state = 'running'
      order by campaign.scheduled_for, recipient.created_at, recipient.id
      limit p_limit for update of recipient skip locked
    )
    update public.whatsapp_campaign_recipients as recipient
    set state = 'in_flight', attempt_count = recipient.attempt_count + 1,
        claimed_at = now(), updated_at = now()
    from chosen where recipient.id = chosen.id
    returning recipient.*
  loop
    insert into public.whatsapp_campaign_send_attempts (
      recipient_id, attempt_number, state
    ) values (claimed.id, claimed.attempt_count, 'in_flight');
    return next claimed;
  end loop;
end;
$$;

create or replace function public.record_whatsapp_campaign_send_result(
  p_recipient_id uuid,
  p_state text,
  p_wamid text,
  p_error_summary text
) returns public.whatsapp_campaign_recipients language plpgsql security definer
set search_path = public, pg_temp
as $$
declare recipient public.whatsapp_campaign_recipients;
declare attempt_state text;
begin
  if p_state not in ('accepted', 'rejected', 'uncertain', 'suppressed', 'canceled', 'deferred')
     or (p_state = 'accepted' and nullif(p_wamid, '') is null)
     or (p_state <> 'accepted' and p_wamid is not null)
     or length(coalesce(p_error_summary, '')) > 500 then
    raise exception 'Invalid campaign send outcome';
  end if;
  if p_wamid is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  end if;

  select * into recipient from public.whatsapp_campaign_recipients
  where id = p_recipient_id for update;
  if recipient.id is null then raise exception 'Campaign recipient not found'; end if;
  if recipient.state = 'uncertain' and p_state not in ('uncertain', 'accepted') then
    -- Once a call may have started, never recycle the row into pending work.
    raise exception 'Uncertain campaign attempt requires reconciliation';
  end if;
  if recipient.state not in ('in_flight', 'uncertain') then
    if recipient.state = p_state and recipient.wamid is not distinct from p_wamid then
      return recipient;
    end if;
    raise exception 'Campaign send outcome cannot be changed';
  end if;

  attempt_state := case when p_state in ('deferred', 'suppressed', 'canceled')
                        then 'rejected' else p_state end;
  update public.whatsapp_campaign_send_attempts
  set state = attempt_state, wamid = p_wamid, error_summary = p_error_summary,
      finished_at = now()
  where recipient_id = p_recipient_id and attempt_number = recipient.attempt_count
    and state in ('in_flight', 'uncertain');
  if not found then raise exception 'Campaign attempt not found'; end if;

  update public.whatsapp_campaign_recipients
  set state = case when p_state = 'deferred' then 'pending' else p_state end,
      wamid = coalesce(p_wamid, wamid), error_summary = p_error_summary,
      finished_at = case when p_state = 'deferred' then null else now() end,
      updated_at = now()
  where id = p_recipient_id returning * into recipient;
  return recipient;
end;
$$;

create or replace function public.mark_stale_whatsapp_campaign_claims()
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare changed integer;
begin
  with stale as (
    update public.whatsapp_campaign_recipients
    set state = 'uncertain', finished_at = now(), updated_at = now(),
        error_summary = 'Worker stopped during an attempt; reconciliation required'
    where state = 'in_flight' and claimed_at < now() - interval '5 minutes'
    returning id, attempt_count
  )
  update public.whatsapp_campaign_send_attempts as attempt
  set state = 'uncertain', finished_at = now(),
      error_summary = 'Worker stopped during an attempt; reconciliation required'
  from stale where attempt.recipient_id = stale.id
    and attempt.attempt_number = stale.attempt_count
    and attempt.state = 'in_flight';
  get diagnostics changed = row_count;
  return changed;
end;
$$;

create or replace function public.reserve_whatsapp_sender_slot(
  p_waba_id text, p_phone_number_id text, p_interval_ms integer
) returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare interval_value interval;
declare slot_at timestamptz;
begin
  if nullif(p_waba_id, '') is null or nullif(p_phone_number_id, '') is null
     or p_interval_ms is null or p_interval_ms < 200 or p_interval_ms > 60000 then
    raise exception 'Invalid sender rate slot';
  end if;
  interval_value := make_interval(secs => p_interval_ms / 1000.0);
  insert into public.whatsapp_sender_rate_slots (
    waba_id, phone_number_id, next_available_at
  ) values (p_waba_id, p_phone_number_id, now() + interval_value)
  on conflict (waba_id, phone_number_id) do update
    set next_available_at = greatest(
      public.whatsapp_sender_rate_slots.next_available_at, now()
    ) + interval_value
  returning next_available_at - interval_value into slot_at;
  return greatest(0, ceil(extract(epoch from (slot_at - now())) * 1000))::integer;
end;
$$;

create or replace function public.finish_whatsapp_campaigns()
returns integer language plpgsql security definer
set search_path = public, pg_temp
as $$
declare changed integer;
begin
  with completed as (
    update public.whatsapp_campaigns as campaign
    set state = 'completed', completed_at = now(), updated_at = now()
    where campaign.state = 'running'
      and not exists (
        select 1 from public.whatsapp_campaign_recipients as recipient
        where recipient.campaign_id = campaign.id
          and recipient.state in ('pending', 'in_flight')
      )
    returning id
  )
  insert into public.whatsapp_campaign_audit (campaign_id, action)
  select id, 'complete' from completed;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

create or replace function public.whatsapp_campaign_counts(p_campaign_id uuid)
returns jsonb language sql security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'pending', count(*) filter (where state = 'pending'),
    'in_flight', count(*) filter (where state = 'in_flight'),
    'accepted', count(*) filter (where state = 'accepted'),
    'rejected', count(*) filter (where state = 'rejected'),
    'uncertain', count(*) filter (where state = 'uncertain'),
    'suppressed', count(*) filter (where state = 'suppressed'),
    'canceled', count(*) filter (where state = 'canceled'),
    'sent', count(*) filter (where delivery_status = 'sent'),
    'delivered', count(*) filter (where delivery_status = 'delivered'),
    'read', count(*) filter (where delivery_status = 'read'),
    'failed', count(*) filter (where delivery_status = 'failed'),
    'delivery_conflict', count(*) filter (where delivery_conflict)
  )
  from public.whatsapp_campaign_recipients
  where campaign_id = p_campaign_id;
$$;

-- Signed webhook receipt in 0001 writes an inbox item. This trigger projects
-- campaign delivery status independently from the test-send projection.
create or replace function public.project_whatsapp_campaign_status(
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
  perform pg_advisory_xact_lock(hashtextextended(p_wamid, 0));
  update public.whatsapp_campaign_recipients as recipient
  set state = case when recipient.state in ('in_flight', 'uncertain')
                   then 'accepted' else recipient.state end,
      delivery_conflict = recipient.delivery_conflict
        or recipient.state = 'rejected'
        or (recipient.delivery_status = 'failed' and p_status <> 'failed')
        or (recipient.delivery_status in ('sent', 'delivered', 'read') and p_status = 'failed'),
      delivery_status = case
        when recipient.delivery_status is null then p_status
        when recipient.delivery_status = 'failed' or p_status = 'failed'
          then recipient.delivery_status
        when case p_status when 'read' then 3 when 'delivered' then 2 else 1 end
           > case recipient.delivery_status when 'read' then 3
             when 'delivered' then 2 else 1 end then p_status
        else recipient.delivery_status
      end,
      last_status_at = greatest(coalesce(recipient.last_status_at, '-infinity'::timestamptz),
                                coalesce(p_event_at, now())),
      updated_at = now()
  from public.whatsapp_campaigns as campaign
  where recipient.campaign_id = campaign.id
    and recipient.wamid = p_wamid and campaign.waba_id = p_waba_id
    and campaign.phone_number_id = p_phone_number_id;
end;
$$;

create or replace function public.project_whatsapp_campaign_webhook_item()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind = 'status' then
    perform public.project_whatsapp_campaign_status(
      new.waba_id, new.phone_number_id, new.provider_message_id,
      new.provider_status, new.event_timestamp
    );
  end if;
  return new;
end;
$$;

drop trigger if exists project_whatsapp_campaign_webhook_item_trigger
  on public.meta_webhook_items;
create trigger project_whatsapp_campaign_webhook_item_trigger
after insert on public.meta_webhook_items
for each row execute function public.project_whatsapp_campaign_webhook_item();

create or replace function public.reconcile_whatsapp_campaign_status()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare event_record record;
declare campaign_record public.whatsapp_campaigns;
begin
  if new.wamid is null then return new; end if;
  if tg_op = 'UPDATE' and new.wamid is not distinct from old.wamid then
    return new;
  end if;
  select * into campaign_record from public.whatsapp_campaigns
  where id = new.campaign_id;
  perform pg_advisory_xact_lock(hashtextextended(new.wamid, 0));
  for event_record in
    select waba_id, phone_number_id, provider_message_id, provider_status, event_timestamp
    from public.meta_webhook_items
    where kind = 'status' and provider_message_id = new.wamid
      and waba_id = campaign_record.waba_id
      and phone_number_id = campaign_record.phone_number_id
    order by coalesce(event_timestamp, received_at), received_at, id
  loop
    perform public.project_whatsapp_campaign_status(
      event_record.waba_id, event_record.phone_number_id,
      event_record.provider_message_id, event_record.provider_status,
      event_record.event_timestamp
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists reconcile_whatsapp_campaign_status_trigger
  on public.whatsapp_campaign_recipients;
create trigger reconcile_whatsapp_campaign_status_trigger
after insert or update of wamid on public.whatsapp_campaign_recipients
for each row execute function public.reconcile_whatsapp_campaign_status();

alter table public.whatsapp_campaigns enable row level security;
alter table public.whatsapp_campaign_recipients enable row level security;
alter table public.whatsapp_campaign_send_attempts enable row level security;
alter table public.whatsapp_campaign_audit enable row level security;
alter table public.whatsapp_sender_rate_slots enable row level security;

revoke all on public.whatsapp_campaigns, public.whatsapp_campaign_recipients,
  public.whatsapp_campaign_send_attempts, public.whatsapp_campaign_audit,
  public.whatsapp_sender_rate_slots from public, anon, authenticated;
grant select on public.whatsapp_campaigns, public.whatsapp_campaign_recipients,
  public.whatsapp_campaign_send_attempts, public.whatsapp_campaign_audit
  to service_role;
grant select, insert, update on public.whatsapp_campaigns,
  public.whatsapp_campaign_recipients, public.whatsapp_campaign_send_attempts,
  public.whatsapp_campaign_audit, public.whatsapp_sender_rate_slots to service_role;

revoke all on function public.create_whatsapp_campaign_draft(
  uuid, text, text, text, text, text, text, jsonb, jsonb, uuid, boolean
) from public, anon, authenticated;
revoke all on function public.transition_whatsapp_campaign(
  uuid, uuid, text, timestamptz, boolean, integer, text)
  from public, anon, authenticated;
revoke all on function public.whatsapp_campaign_recipient_eligible(uuid)
  from public, anon, authenticated;
revoke all on function public.whatsapp_campaign_send_gate(uuid)
  from public, anon, authenticated;
revoke all on function public.worker_pause_whatsapp_campaign(uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_whatsapp_campaign_recipients(integer)
  from public, anon, authenticated;
revoke all on function public.record_whatsapp_campaign_send_result(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.mark_stale_whatsapp_campaign_claims()
  from public, anon, authenticated;
revoke all on function public.reserve_whatsapp_sender_slot(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.finish_whatsapp_campaigns()
  from public, anon, authenticated;
revoke all on function public.whatsapp_campaign_counts(uuid)
  from public, anon, authenticated;
revoke all on function public.project_whatsapp_campaign_status(text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.project_whatsapp_campaign_webhook_item()
  from public, anon, authenticated;
revoke all on function public.reconcile_whatsapp_campaign_status()
  from public, anon, authenticated;

grant execute on function public.create_whatsapp_campaign_draft(
  uuid, text, text, text, text, text, text, jsonb, jsonb, uuid, boolean
) to service_role;
grant execute on function public.transition_whatsapp_campaign(
  uuid, uuid, text, timestamptz, boolean, integer, text)
  to service_role;
grant execute on function public.whatsapp_campaign_recipient_eligible(uuid)
  to service_role;
grant execute on function public.whatsapp_campaign_send_gate(uuid)
  to service_role;
grant execute on function public.worker_pause_whatsapp_campaign(uuid, text)
  to service_role;
grant execute on function public.claim_whatsapp_campaign_recipients(integer)
  to service_role;
grant execute on function public.record_whatsapp_campaign_send_result(uuid, text, text, text)
  to service_role;
grant execute on function public.mark_stale_whatsapp_campaign_claims()
  to service_role;
grant execute on function public.reserve_whatsapp_sender_slot(text, text, integer)
  to service_role;
grant execute on function public.finish_whatsapp_campaigns()
  to service_role;
grant execute on function public.whatsapp_campaign_counts(uuid)
  to service_role;
