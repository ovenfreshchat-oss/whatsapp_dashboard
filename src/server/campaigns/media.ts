import { randomUUID } from "node:crypto";
import { CampaignInputError } from "@/server/campaigns/admin";
import { CampaignStoreError, getCampaignStore } from "@/server/campaigns/store";

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
