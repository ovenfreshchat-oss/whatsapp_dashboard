import { randomUUID } from "node:crypto";
import { CampaignInputError } from "@/server/campaigns/admin";
import { CampaignStoreError, getCampaignStore } from "@/server/campaigns/store";
import { headerVideoPath, headerVideoPathFromUrl, MAX_HEADER_VIDEO_BYTES } from "@/server/campaigns/media-paths";

const BUCKET = "campaign-media";
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES: Record<string, { ext: string; magic: number[] }> = {
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
};

/** Uploads a header image to the public bucket and returns its HTTPS URL for the Meta template header. */
export async function uploadCampaignHeaderImage(file: File): Promise<string> {
  const type = TYPES[file.type];
  if (!type) throw new CampaignInputError("The header image must be a JPG or PNG file.");
  if (file.size > MAX_BYTES) throw new CampaignInputError("Header image must be 4 MB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.magic.every((value, index) => bytes[index] === value)) {
    throw new CampaignInputError("That file is not a valid JPG or PNG image. Please choose another.");
  }
  const store = getCampaignStore();
  const path = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${type.ext}`;
  const { error } = await store.storage.from(BUCKET).upload(path, bytes, {
    contentType: file.type,
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw new CampaignStoreError("The image could not be uploaded. Please try again.");
  return store.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

function publicPrefix(): string {
  return getCampaignStore().storage.from(BUCKET).getPublicUrl("x").data.publicUrl.slice(0, -1);
}

/** A one-time upload slot so the browser can send a video straight to storage (a server action cannot take 16 MB on Vercel). */
export async function createHeaderVideoUpload(): Promise<{ signedUrl: string; publicUrl: string }> {
  const bucket = getCampaignStore().storage.from(BUCKET);
  const path = headerVideoPath(new Date().toISOString().slice(0, 10), randomUUID());
  const { data, error } = await bucket.createSignedUploadUrl(path);
  if (error || !data) throw new CampaignStoreError("The video upload could not be started. Please try again.");
  return { signedUrl: data.signedUrl, publicUrl: bucket.getPublicUrl(path).data.publicUrl };
}

/** Accepts only a video URL created above, and checks what is really stored: an MP4 of 16 MB or less. */
export async function assertHeaderVideoUrl(url: string): Promise<string> {
  const clean = url.trim();
  if (!headerVideoPathFromUrl(clean, publicPrefix())) throw new CampaignInputError("The header video is not valid. Please upload it again.");
  let response: Response;
  try { response = await fetch(clean, { method: "HEAD", signal: AbortSignal.timeout(15_000) }); } catch {
    throw new CampaignInputError("The header video could not be checked. Please upload it again.");
  }
  const size = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("video/mp4") || size <= 0) {
    throw new CampaignInputError("The header video was not uploaded. Please choose the MP4 again.");
  }
  if (size > MAX_HEADER_VIDEO_BYTES) throw new CampaignInputError("The header video must be 16 MB or smaller.");
  return clean;
}

/** Reads a checked header video back from storage (used to send the template sample to WhatsApp). */
export async function readHeaderVideo(url: string): Promise<Uint8Array> {
  const path = headerVideoPathFromUrl((await assertHeaderVideoUrl(url)), publicPrefix());
  if (!path) throw new CampaignInputError("The header video is not valid. Please upload it again.");
  const { data, error } = await getCampaignStore().storage.from(BUCKET).download(path);
  if (error || !data) throw new CampaignStoreError("The header video could not be read. Please upload it again.");
  return new Uint8Array(await data.arrayBuffer());
}
