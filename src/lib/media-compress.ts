import {
  IMAGE_JPEG_QUALITY, IMAGE_SKIP_BYTES, formatSize, planImageSize, planVideoCompression, worthKeeping,
} from "@/lib/media-compress-plan";

export type CompressResult = {
  file: File;
  beforeBytes: number;
  afterBytes: number;
  compressed: boolean;
  /** A short plain sentence the form can show, for example "13.4 MB → 2.9 MB". */
  message: string;
};

function unchanged(file: File, message = ""): CompressResult {
  return { file, beforeBytes: file.size, afterBytes: file.size, compressed: false, message };
}

function withExtension(name: string, extension: string): string {
  return `${name.replace(/\.[^./\\]+$/, "") || "header"}.${extension}`;
}

/**
 * Re-encodes a header video in the browser (H.264 + AAC, at most 1280x720) so it is far smaller to store and for
 * WhatsApp to download. Returns the original file when it is already small, when the browser cannot encode it, or
 * when the new file would not be clearly smaller. Never throws: the original is always a safe fallback.
 */
export async function compressHeaderVideo(file: File, onProgress?: (fraction: number) => void): Promise<CompressResult> {
  if (typeof window === "undefined" || typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") {
    return unchanged(file, "This browser cannot optimise videos, so the original is used.");
  }
  try {
    const mb = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return unchanged(file);
      const plan = planVideoCompression({
        width: track.displayWidth, height: track.displayHeight,
        durationSeconds: await input.computeDuration(), sizeBytes: file.size,
      });
      if (!plan) return unchanged(file);
      const hasAudio = Boolean(await input.getPrimaryAudioTrack());
      const canVideo = await mb.canEncodeVideo("avc", { width: plan.width, height: plan.height, bitrate: plan.videoBitrate });
      const canAudio = !hasAudio || await mb.canEncodeAudio("aac", { bitrate: plan.audioBitrate });
      if (!canVideo || !canAudio) return unchanged(file, "This browser cannot optimise this video, so the original is used.");

      const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
      const conversion = await mb.Conversion.init({
        input, output,
        video: { codec: "avc", width: plan.width, height: plan.height, fit: "contain", bitrate: plan.videoBitrate },
        audio: { codec: "aac", bitrate: plan.audioBitrate },
      });
      // A track that cannot be carried over (for example audio we cannot decode) would be silently lost.
      if (!conversion.isValid || conversion.discardedTracks.length > 0) {
        return unchanged(file, "This video could not be optimised, so the original is used.");
      }
      if (onProgress) conversion.onProgress = onProgress;
      await conversion.execute();
      const buffer = output.target.buffer;
      if (!buffer || !worthKeeping(file.size, buffer.byteLength)) return unchanged(file);
      const result = new File([buffer], withExtension(file.name, "mp4"), { type: "video/mp4", lastModified: Date.now() });
      return {
        file: result, beforeBytes: file.size, afterBytes: result.size, compressed: true,
        message: `Optimised: ${formatSize(file.size)} → ${formatSize(result.size)}.`,
      };
    } finally {
      input.dispose?.();
    }
  } catch {
    return unchanged(file, "The video could not be optimised, so the original is used.");
  }
}

async function hasTransparency(bitmap: ImageBitmap): Promise<boolean> {
  const size = Math.min(64, bitmap.width, bitmap.height);
  const probe = document.createElement("canvas");
  probe.width = size; probe.height = size;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) return true;
  context.drawImage(bitmap, 0, 0, size, size);
  const data = context.getImageData(0, 0, size, size).data;
  for (let index = 3; index < data.length; index += 4) if (data[index] < 255) return true;
  return false;
}

/**
 * Shrinks a large header image without a visible change: a picture without transparency becomes a high quality JPEG
 * (quality 0.92) and is only scaled down when it is wider than WhatsApp ever shows (1600 px). Transparent PNGs and
 * images that are already small are left as they are.
 */
export async function compressHeaderImage(file: File): Promise<CompressResult> {
  if (typeof window === "undefined" || file.size <= IMAGE_SKIP_BYTES) return unchanged(file);
  if (file.type !== "image/png" && file.type !== "image/jpeg") return unchanged(file);
  try {
    const bitmap = await createImageBitmap(file);
    try {
      if (file.type === "image/png" && await hasTransparency(bitmap)) return unchanged(file);
      const { width, height } = planImageSize(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return unchanged(file);
      context.imageSmoothingQuality = "high";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", IMAGE_JPEG_QUALITY));
      if (!blob || !worthKeeping(file.size, blob.size)) return unchanged(file);
      const result = new File([blob], withExtension(file.name, "jpg"), { type: "image/jpeg", lastModified: Date.now() });
      return {
        file: result, beforeBytes: file.size, afterBytes: result.size, compressed: true,
        message: `Optimised: ${formatSize(file.size)} → ${formatSize(result.size)}.`,
      };
    } finally {
      bitmap.close();
    }
  } catch {
    return unchanged(file);
  }
}
