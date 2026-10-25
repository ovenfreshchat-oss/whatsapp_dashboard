-- 0019: sender holds can never block sending again.
-- Clear STOP/UNSUBSCRIBE messages are still opted out per customer (0013/0014).
-- Ambiguous opt-out wording no longer pauses the whole sender or the inbox.

update public.meta_sender_holds set released_at = now() where released_at is null;

update public.meta_ambiguous_opt_out_events set reviewed_at = now() where reviewed_at is null;

create or replace function public.meta_sender_holds_never_block()
returns trigger language plpgsql as $$
begin
  new.released_at := coalesce(new.released_at, now());
  return new;
end;
$$;

drop trigger if exists meta_sender_holds_never_block on public.meta_sender_holds;
create trigger meta_sender_holds_never_block
  before insert or update on public.meta_sender_holds
  for each row execute function public.meta_sender_holds_never_block();
