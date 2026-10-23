-- Apply after 0003_campaigns.sql and 0004_contact_import_pgcrypto_path.sql.
-- Adds optional header_media_url to support approved marketing templates with media headers (e.g. image).

alter table public.whatsapp_campaigns
  add column if not exists header_media_url text;
