-- Temporary send throttle: send at most p_batch messages, then pause p_cooldown_minutes before
-- the next batch. It is computed from the send-attempt log, so there is no extra state to drift:
--   * "sends" are attempts that were claimed for sending and not skipped: in_flight, accepted or
--     uncertain. Opted-out / suppressed / deferred / rejected attempts do not use up the batch.
--   * A batch is a run of sends where no gap reaches the cooldown. The cooldown runs from the
--     last send, so once p_batch sends are done, nothing more is allowed until that long after.
-- The worker calls this before every claim and caps the claim to `allowed`. Apply after 0011.
-- Safe to rerun. Turn the throttle off by unsetting the two WHATSAPP_THROTTLE_* variables.

create index if not exists whatsapp_campaign_send_attempts_started_idx
  on public.whatsapp_campaign_send_attempts (started_at desc);

create or replace function public.campaign_send_throttle(
  p_batch integer, p_cooldown_minutes integer
) returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_cooldown interval;
  v_last timestamptz;
  v_burst_start timestamptz;
  v_count integer;
begin
  if p_batch is null or p_batch not between 1 and 500
     or p_cooldown_minutes is null or p_cooldown_minutes not between 1 and 1440 then
    raise exception 'Invalid send throttle';
  end if;
  v_cooldown := make_interval(mins => p_cooldown_minutes);

  select max(started_at) into v_last
  from public.whatsapp_campaign_send_attempts
  where state in ('in_flight', 'accepted', 'uncertain');

  -- Nothing sent yet, or the last send is older than the cooldown: a fresh batch.
  if v_last is null or now() >= v_last + v_cooldown then
    return jsonb_build_object('allowed', p_batch, 'wait_until', null);
  end if;

  -- Start of the current batch: the first send after the latest gap of at least one cooldown.
  select max(started_at) into v_burst_start
  from (
    select started_at,
           lag(started_at) over (order by started_at) as previous_at
    from public.whatsapp_campaign_send_attempts
    where state in ('in_flight', 'accepted', 'uncertain')
      and started_at > now() - (v_cooldown * 2 + interval '2 days')
  ) as attempts
  where previous_at is null or started_at - previous_at >= v_cooldown;

  select count(*) into v_count
  from public.whatsapp_campaign_send_attempts
  where state in ('in_flight', 'accepted', 'uncertain')
    and started_at >= coalesce(v_burst_start, v_last);

  if v_count >= p_batch then
    return jsonb_build_object('allowed', 0, 'wait_until', v_last + v_cooldown);
  end if;
  return jsonb_build_object('allowed', p_batch - v_count, 'wait_until', null);
end;
$$;

revoke all on function public.campaign_send_throttle(integer, integer) from public, anon, authenticated;
grant execute on function public.campaign_send_throttle(integer, integer) to service_role;
