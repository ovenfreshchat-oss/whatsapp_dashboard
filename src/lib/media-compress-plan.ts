/** Pure sizing rules for header media compression (no browser APIs, so they can be unit tested). */

export const MB = 1024 * 1024;
/** Videos at or under this size are already small enough to send as they are. */
export const VIDEO_SKIP_BYTES = 2 * MB;
/** The biggest video we try to optimise in the browser. */
export const MAX_SOURCE_VIDEO_BYTES = 200 * MB;
/** WhatsApp's limit for a video header. */
export const MAX_OUTPUT_VIDEO_BYTES = 16 * MB;
/** Longest side 1280 px, shortest side 720 px: sharp on any phone, much smaller than 1080p. */
const LONG_EDGE = 1280;
const SHORT_EDGE = 720;
const AUDIO_BITRATE = 96_000;
/** Bits per pixel per frame at 30 fps for H.264: clean motion without visible blocking. */
const BITS_PER_PIXEL = 0.07;
const MIN_VIDEO_BITRATE = 500_000;
/** A video estimated to be bigger than this is encoded at a lower bitrate to fit. */
const TARGET_MAX_BYTES = 8 * MB;

export type VideoPlanInput = { width: number; height: number; durationSeconds: number; sizeBytes: number };
export type VideoPlan = { width: number; height: number; videoBitrate: number; audioBitrate: number; estimatedBytes: number };

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/** Returns how to re-encode the video, or null when it should be uploaded unchanged. */
export function planVideoCompression(input: VideoPlanInput): VideoPlan | null {
  const { width, height, durationSeconds, sizeBytes } = input;
  if (![width, height, durationSeconds, sizeBytes].every((value) => Number.isFinite(value) && value > 0)) return null;
  if (sizeBytes <= VIDEO_SKIP_BYTES) return null;

  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const scale = Math.min(1, LONG_EDGE / longSide, SHORT_EDGE / shortSide);
  const outWidth = even(width * scale);
  const outHeight = even(height * scale);

  const sourceBitrate = (sizeBytes * 8) / durationSeconds;
  let videoBitrate = outWidth * outHeight * 30 * BITS_PER_PIXEL;
  // Never ask for more than the source already has: that only grows the file.
  videoBitrate = Math.min(videoBitrate, Math.max(MIN_VIDEO_BITRATE, sourceBitrate * 0.9 - AUDIO_BITRATE));
  const budget = (TARGET_MAX_BYTES * 8) / durationSeconds - AUDIO_BITRATE;
  videoBitrate = Math.max(MIN_VIDEO_BITRATE, Math.min(videoBitrate, budget));
  videoBitrate = Math.round(videoBitrate / 1000) * 1000;

  const estimatedBytes = Math.round(((videoBitrate + AUDIO_BITRATE) * durationSeconds) / 8);
  // The source is already about as small as we would make it: re-encoding would only cost quality.
  if (!worthKeeping(sizeBytes, estimatedBytes)) return null;
  return { width: outWidth, height: outHeight, videoBitrate, audioBitrate: AUDIO_BITRATE, estimatedBytes };
}

/** Keep the new file only when it is clearly smaller, so a compression never makes things worse. */
export function worthKeeping(beforeBytes: number, afterBytes: number): boolean {
  return afterBytes > 0 && afterBytes <= beforeBytes * 0.9;
}

export const IMAGE_SKIP_BYTES = 300 * 1024;
export const IMAGE_MAX_EDGE = 1600;
export const IMAGE_JPEG_QUALITY = 0.92;

/** Target size of an image header: only shrink when the picture is bigger than WhatsApp ever shows. */
export function planImageSize(width: number, height: number): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (!Number.isFinite(longSide) || longSide <= IMAGE_MAX_EDGE) return { width, height };
  const scale = IMAGE_MAX_EDGE / longSide;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** "13.4 MB", "820 KB". */
export function formatSize(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
