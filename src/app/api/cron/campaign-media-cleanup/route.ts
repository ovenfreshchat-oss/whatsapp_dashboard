import { createHash, timingSafeEqual } from "node:crypto";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { getCampaignStore } from "@/server/campaigns/store";
import { headerMediaFromUrl } from "@/server/campaigns/media-paths";
import { isAuthorizedCron } from "@/server/inbox/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "campaign-media";
const CLEAN_DAYS = 1;   // campaign had no failed messages
const FAILED_DAYS = 4;  // campaign had failed messages: days after the last failure/retry activity

const digest = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** Daily Vercel cron: deletes campaign header images/videos that are no longer needed (see drizzle/0032). */
export async function GET(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET, safeEqual)) {
    return new Response("Not allowed", { status: 401, headers });
  }
  const admin = createStaffAdminClient();
  if (!admin) return new Response("Unavailable", { status: 503, headers });

  const { data, error } = await admin.rpc("campaigns_with_expired_media", {
    p_clean_days: CLEAN_DAYS, p_failed_days: FAILED_DAYS, p_wait_for_retries: true,
  });
  if (error) {
    console.error("Media cleanup lookup failed", { code: error.code });
    return Response.json({ ok: false }, { status: 500, headers });
  }

  const bucket = getCampaignStore().storage.from(BUCKET);
  const prefix = bucket.getPublicUrl("x").data.publicUrl.slice(0, -1);
  const urls = [...new Set(((data ?? []) as { media_url: string }[]).map((row) => row.media_url))];
  let removed = 0, skipped = 0, failed = 0;
  for (const url of urls) {
    const media = headerMediaFromUrl(url, prefix);
    if (!media) { skipped += 1; continue; } // not a file we host: nothing to delete
    const { error: removeError } = await bucket.remove([media.path]);
    if (removeError) { failed += 1; console.error("Media delete failed", { path: media.path }); continue; }
    const { error: markError } = await admin.rpc("mark_campaign_media_removed", { p_media_url: url });
    if (markError) { failed += 1; console.error("Media mark failed", { code: markError.code }); continue; }
    removed += 1;
  }
  return Response.json({ ok: failed === 0, removed, skipped, failed }, { headers });
}
