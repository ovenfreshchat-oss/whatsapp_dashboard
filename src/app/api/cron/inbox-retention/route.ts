import { createHash, timingSafeEqual } from "node:crypto";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { isAuthorizedCron, parseRetentionDays, retentionCutoff } from "@/server/inbox/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const digest = (value: string) => createHash("sha256").update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** Daily Vercel cron: removes chat messages older than the retention period (default 90 days). */
export async function GET(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET, safeEqual)) {
    return new Response("Not allowed", { status: 401, headers });
  }
  const admin = createStaffAdminClient();
  if (!admin) return new Response("Unavailable", { status: 503, headers });

  const days = parseRetentionDays(process.env.INBOX_RETENTION_DAYS);
  const { data, error } = await admin.rpc("purge_inbox_history", { p_before: retentionCutoff(days).toISOString() });
  if (error) return Response.json({ ok: false }, { status: 500, headers });
  return Response.json({ ok: true, retentionDays: days, result: data }, { headers });
}
