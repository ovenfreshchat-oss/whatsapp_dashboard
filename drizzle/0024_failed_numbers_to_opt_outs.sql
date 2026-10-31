-- Automatically keep numbers that Meta could not deliver to out of future campaigns.
-- Apply after 0010, 0013 and 0016. Safe to rerun.
--
-- When Meta reports a failed delivery for a campaign message with one of these error codes, the
-- recipient's number is added to the do-not-contact list (opt_out_numbers). Campaign audiences and
-- the send-time check already skip every number on that list, so the next campaign leaves them out.
--   131026  Message undeliverable (not on WhatsApp, or cannot receive it)
--   131050  Recipient chose to stop receiving marketing messages from your business
--   131049  Not delivered to maintain healthy ecosystem engagement (Meta limited this user)
--   130472  User's number is part of a Meta experiment
-- Other failure codes (media, template or temporary errors) are NOT added, because a retry may work.
-- The error code is written into the list's "source" so you can filter or release them later.
-- A number you released stays released: nothing here re-activates it.

create or replace function public.failed_delivery_opt_out_codes()
returns text[] language sql immutable
as $$ select array['131026', '131050', '131049', '130472']::text[] $$;

-- Backfill: every campaign recipient that already has one of those failures.
insert into public.opt_out_numbers (phone_e164, source)
select r.recipient_e164,
       left('Delivery failed (code ' || f.code || ') - automatic', 200)
from (
  select distinct on (i.provider_message_id)
         i.provider_message_id as wamid,
         i.payload->'errors'->0->>'code' as code
  from public.meta_webhook_items i
  where i.kind = 'status' and i.provider_status = 'failed'
    and i.payload->'errors'->0->>'code' = any (public.failed_delivery_opt_out_codes())
  order by i.provider_message_id, i.received_at desc
) f
join public.whatsapp_campaign_recipients r on r.wamid = f.wamid
where r.recipient_e164 ~ '^\+[1-9][0-9]{7,14}$'
on conflict (phone_e164) do nothing;

create or replace function public.sync_failed_delivery_to_opt_outs()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := new.payload->'errors'->0->>'code';
  v_phone text;
begin
  if new.kind <> 'status' or new.provider_status is distinct from 'failed'
     or new.provider_message_id is null
     or v_code is null or not (v_code = any (public.failed_delivery_opt_out_codes())) then
    return new;
  end if;

  select recipient.recipient_e164 into v_phone
  from public.whatsapp_campaign_recipients recipient
  where recipient.wamid = new.provider_message_id
  limit 1;

  if v_phone is not null and v_phone ~ '^\+[1-9][0-9]{7,14}$' then
    insert into public.opt_out_numbers (phone_e164, source)
    values (v_phone, left('Delivery failed (code ' || v_code || ') - automatic', 200))
    on conflict (phone_e164) do nothing;
  end if;
  return new;
exception when others then
  -- Never fail webhook receipt because of this convenience list.
  raise warning 'failed-delivery opt-out sync skipped: %', sqlstate;
  return new;
end;
$$;

drop trigger if exists sync_failed_delivery_to_opt_outs_trigger on public.meta_webhook_items;
create trigger sync_failed_delivery_to_opt_outs_trigger
after insert on public.meta_webhook_items
for each row execute function public.sync_failed_delivery_to_opt_outs();

revoke all on function public.sync_failed_delivery_to_opt_outs() from public, anon, authenticated;
revoke all on function public.failed_delivery_opt_out_codes() from public, anon, authenticated;
