-- Repair existing installs where pgcrypto lives in Supabase's extensions
-- schema. import_contact_batch uses digest() to hash the import request.
-- Its original fixed search_path omitted extensions and raised SQLSTATE 42883.
-- This ALTER is safe to rerun and leaves imported data unchanged.
alter function public.import_contact_batch(uuid, uuid, text, text, text, jsonb, jsonb)
  set search_path = extensions, public, pg_temp;
