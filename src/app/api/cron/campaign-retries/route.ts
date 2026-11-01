import { createHash, timingSafeEqual } from "node:crypto";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { isAuthorizedCron } from "@/server/inbox/retention";
import { startCampaignSendWorkflow } from "@/server/campaigns/start-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const digest = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * Safety net for automatic retries. The sender normally stays awake until a retry is due, but if it
 * ever stopped (deploy, outage), this starts it again when something is due. Safe to call often:
 * a second run exits on the single-sender lease.
 */
export async function GET(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET, safeEqual)) {
    return new Response("Not allowed", { status: 401, headers });
  }
  const admin = createStaffAdminClient();
  if (!admin) return new Response("Unavailable", { status: 503, headers });

  const { data, error } = await admin.rpc("campaign_worker_status");
  if (error || !data) return Response.json({ ok: false }, { status: 500, headers });
  const status = data as { running_pending?: boolean; next_scheduled_at?: string | null };
  const due = status.running_pending === true || Boolean(status.next_scheduled_at);
  const started = due ? await startCampaignSendWorkflow().catch(() => false) : false;
  return Response.json({ ok: true, due, started }, { headers });
}
