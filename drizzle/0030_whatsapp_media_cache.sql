-- Remembers the WhatsApp media ID of each campaign header image or video, per sender number.
-- The file is uploaded to WhatsApp once and every message (and retry) then sends the small ID instead of
-- a Supabase link, so WhatsApp stops downloading the same file from Storage for every recipient.
-- WhatsApp keeps an uploaded file for 30 days; the application stops using an ID after 25.
create table if not exists public.whatsapp_media_cache (
  source_url text not null,
  phone_number_id text not null,
  media_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (source_url, phone_number_id)
);

alter table public.whatsapp_media_cache enable row level security;
revoke all on public.whatsapp_media_cache from public, anon, authenticated;
grant select, insert, update, delete on public.whatsapp_media_cache to service_role;
