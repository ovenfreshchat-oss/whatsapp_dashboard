-- Public bucket for WhatsApp campaign header images. Meta fetches the image by public HTTPS URL.
-- Uploads happen only from the server (service-role key); the bucket is read-only to the public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('campaign-media', 'campaign-media', true, 4194304, array['image/jpeg','image/png'])
on conflict (id) do update
  set public = true, file_size_limit = 4194304, allowed_mime_types = array['image/jpeg','image/png'];
