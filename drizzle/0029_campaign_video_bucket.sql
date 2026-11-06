-- Allow MP4 video headers in the public campaign media bucket (WhatsApp limit: 16 MB).
-- Videos are uploaded straight from the browser with a short-lived signed upload URL created by the server.
-- Images stay limited to 4 MB by the application. Also check Supabase > Storage > Settings: the global file size limit must be at least 16 MB.
update storage.buckets
  set file_size_limit = 16777216,
      allowed_mime_types = array['image/jpeg','image/png','video/mp4']
  where id = 'campaign-media';
