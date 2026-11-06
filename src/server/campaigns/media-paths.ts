export const MAX_HEADER_VIDEO_BYTES = 16 * 1024 * 1024;
const VIDEO_PATH = /^videos\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;

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
