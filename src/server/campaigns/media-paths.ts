export const MAX_HEADER_VIDEO_BYTES = 16 * 1024 * 1024;
const VIDEO_PATH = /^videos\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;

const IMAGE_PATH = /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;

/** The bucket path and file type of a header image or video link we created, or null for any other URL. */
export function headerMediaFromUrl(url: string, publicPrefix: string): { path: string; mime: string; filename: string } | null {
  if (typeof url !== "string" || !url.startsWith(publicPrefix)) return null;
  const path = url.slice(publicPrefix.length);
  const mime = VIDEO_PATH.test(path) ? "video/mp4"
    : IMAGE_PATH.test(path) ? (path.endsWith(".png") ? "image/png" : "image/jpeg") : null;
  return mime ? { path, mime, filename: path.slice(path.lastIndexOf("/") + 1) } : null;
}

/** Where a header video lives inside the media bucket. */
export function headerVideoPath(day: string, id: string): string {
  return `videos/${day}/${id}.mp4`;
}

/** Returns the bucket path of a header video URL we created, or null for any other URL. */
export function headerVideoPathFromUrl(url: string, publicPrefix: string): string | null {
  if (typeof url !== "string" || !url.startsWith(publicPrefix)) return null;
  const path = url.slice(publicPrefix.length);
  return VIDEO_PATH.test(path) ? path : null;
}
