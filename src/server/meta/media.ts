import { metaGraphGet } from "./client";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const ALLOWED_HOST = /(^|\.)(fbsbx\.com|fbcdn\.net|whatsapp\.net|facebook\.com)$/i;
const INLINE_TYPE = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|3gpp)|audio\/(ogg|mpeg|mp4|aac|amr|webm))(;|$)/i;

export type MetaMedia = { response: Response; contentType: string; inline: boolean };

/**
 * Looks up a received media id, then streams the file from Meta with the access token.
 * The download URL comes from Meta and is only followed over https on Meta-owned hosts.
 */
export async function fetchMetaMedia(mediaId: string): Promise<MetaMedia | null> {
  if (!/^\d{5,30}$/.test(mediaId)) return null;
  const info = await metaGraphGet(mediaId);
  const url = typeof info.url === "string" ? info.url : "";
  const size = typeof info.file_size === "number" ? info.file_size : 0;
  if (size > MAX_MEDIA_BYTES) return null;
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) return null;

  const token = process.env.META_SYSTEM_USER_ACCESS_TOKEN?.trim();
  if (!token) return null;
  const response = await fetch(target, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) return null;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) return null;
  const mime = typeof info.mime_type === "string" ? info.mime_type : response.headers.get("content-type") ?? "";
  const inline = INLINE_TYPE.test(mime);
  return { response, contentType: inline ? mime : "application/octet-stream", inline };
}
