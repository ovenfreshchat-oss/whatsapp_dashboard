import { getCampaignStore } from "@/server/campaigns/store";
import { headerMediaFromUrl } from "@/server/campaigns/media-paths";
import { metaGraphUploadMedia } from "./client";
import { createHeaderMediaResolver, MEDIA_ID_TTL_MS, type MediaIdDeps } from "./media-id-core";

const BUCKET = "campaign-media";
const TABLE = "whatsapp_media_cache";

function publicPrefix(): string {
  return getCampaignStore().storage.from(BUCKET).getPublicUrl("x").data.publicUrl.slice(0, -1);
}

const deps: MediaIdDeps = {
  async lookup(sourceUrl, phoneNumberId) {
    const { data, error } = await getCampaignStore().from(TABLE).select("media_id,expires_at")
      .eq("source_url", sourceUrl).eq("phone_number_id", phoneNumberId).maybeSingle();
    if (error || !data) return null;
    const expires = Date.parse(String(data.expires_at));
    return Number.isFinite(expires) && expires > Date.now() && typeof data.media_id === "string" ? data.media_id : null;
  },
  async save(sourceUrl, phoneNumberId, mediaId) {
    const { error } = await getCampaignStore().from(TABLE).upsert({
      source_url: sourceUrl, phone_number_id: phoneNumberId, media_id: mediaId,
      expires_at: new Date(Date.now() + MEDIA_ID_TTL_MS).toISOString(),
    });
    if (error) throw new Error("The media ID could not be saved.");
  },
  async forget(sourceUrl, phoneNumberId) {
    await getCampaignStore().from(TABLE).delete().eq("source_url", sourceUrl).eq("phone_number_id", phoneNumberId);
  },
  async fetchFile(sourceUrl) {
    const media = headerMediaFromUrl(sourceUrl, publicPrefix());
    if (!media) return null;
    const { data, error } = await getCampaignStore().storage.from(BUCKET).download(media.path);
    if (error || !data) return null;
    return { bytes: new Uint8Array(await data.arrayBuffer()), mime: media.mime, filename: media.filename };
  },
  upload: (phoneNumberId, file) => metaGraphUploadMedia(phoneNumberId, file),
};

/** Shared by every send in this process: the first message uploads the file, the rest reuse its ID. */
export const headerMedia = createHeaderMediaResolver(deps);
