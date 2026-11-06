export const MAX_VIDEO_BYTES = 16 * 1024 * 1024;

/** Returns an error message when the file cannot be a WhatsApp header video, otherwise an empty string. */
export function checkHeaderVideo(file: File): string {
  if (file.type !== "video/mp4") return "Use an MP4 video.";
  if (file.size === 0) return "That video is empty.";
  if (file.size > MAX_VIDEO_BYTES) return "The video is larger than 16 MB. Choose a smaller one.";
  return "";
}

/** Uploads a header video straight to storage and returns its public HTTPS link. Throws an Error with a plain message. */
export async function uploadHeaderVideo(file: File): Promise<string> {
  const invalid = checkHeaderVideo(file);
  if (invalid) throw new Error(invalid);
  const slot = await fetch("/api/media/video-upload", { method: "POST" });
  const value = await slot.json().catch(() => ({})) as { signedUrl?: string; publicUrl?: string; error?: string };
  if (!slot.ok || !value.signedUrl || !value.publicUrl) throw new Error(value.error ?? "The video upload could not be started.");
  const put = await fetch(value.signedUrl, {
    method: "PUT",
    headers: {
      "content-type": "video/mp4", "x-upsert": "false", "cache-control": "max-age=31536000",
      apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    },
    body: file,
  });
  if (!put.ok) throw new Error("The video could not be uploaded. Check your connection and try again.");
  return value.publicUrl;
}
