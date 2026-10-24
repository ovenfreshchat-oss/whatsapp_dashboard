-- Automatically add every customer STOP reply (meta_opt_outs) to the do-not-contact list
-- (opt_out_numbers), and backfill the ones already received. Safe to rerun.
-- Apply after 0010.
create or replace function public.sync_meta_opt_out_to_list()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_phone text := '+' || regexp_replace(new.identity_value, '^\+', '');
begin
  if v_phone ~ '^\+[1-9][0-9]{7,14}$' then
    insert into public.opt_out_numbers (phone_e164, source)
    values (v_phone, 'Customer STOP reply (automatic)')
    on conflict (phone_e164) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_meta_opt_out_to_list_trigger on public.meta_opt_outs;
create trigger sync_meta_opt_out_to_list_trigger
after insert on public.meta_opt_outs
for each row execute function public.sync_meta_opt_out_to_list();

insert into public.opt_out_numbers (phone_e164, source)
select '+' || regexp_replace(identity_value, '^\+', ''), 'Customer STOP reply (automatic)'
from public.meta_opt_outs
where '+' || regexp_replace(identity_value, '^\+', '') ~ '^\+[1-9][0-9]{7,14}$'
on conflict (phone_e164) do nothing;
