-- Fix: a customer's real STOP reply (meta_opt_outs) silently failed to reactivate the do-not-contact
-- list (opt_out_numbers) when that phone number already had a released row there (e.g. from an
-- earlier, since-corrected automatic opt-out, or a staff release). The trigger from
-- 0013_auto_opt_out_numbers.sql used "on conflict (phone_e164) do nothing", so a genuine new STOP
-- was dropped whenever a released row already existed, leaving the contact wrongly eligible for
-- future campaigns despite opting out. add_opt_out_numbers (0010) already reactivates correctly on
-- conflict; this migration brings the automatic trigger in line with it and backfills every number
-- currently affected. Apply after 0013. Safe to rerun.

create or replace function public.sync_meta_opt_out_to_list()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_phone text := '+' || regexp_replace(new.identity_value, '^\+', '');
begin
  if v_phone ~ '^\+[1-9][0-9]{7,14}$' then
    insert into public.opt_out_numbers (phone_e164, source)
    values (v_phone, 'Customer STOP reply (automatic)')
    on conflict (phone_e164) do update
      set released_at = null, released_by = null, created_at = now(),
          source = excluded.source
      where public.opt_out_numbers.released_at is not null;
  end if;
  return new;
end;
$$;

-- Backfill: reactivate (or add) the do-not-contact entry for every phone number that has ever sent a
-- confirmed STOP (meta_opt_outs), in case the old "do nothing" trigger already dropped it.
insert into public.opt_out_numbers (phone_e164, source)
select distinct '+' || regexp_replace(m.identity_value, '^\+', ''), 'Customer STOP reply (automatic)'
from public.meta_opt_outs m
where '+' || regexp_replace(m.identity_value, '^\+', '') ~ '^\+[1-9][0-9]{7,14}$'
on conflict (phone_e164) do update
  set released_at = null, released_by = null, created_at = now(),
      source = excluded.source
  where public.opt_out_numbers.released_at is not null;
