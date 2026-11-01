import { createStaffAdminClient, getWorkspaceReadAccess } from "@/server/auth/staff-users/admin";
import { parseCampaignFilter } from "@/server/campaigns/retries";
import { csvCell } from "@/server/campaigns/retry-math";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 1000;
const MAX_ROWS = 50_000;
const HEADER = ["Phone", "Campaign", "Error code", "Error", "Failed at (UTC)", "Retries made", "Retry status", "Next retry (UTC)", "Contact status"];

/** "Export Failed Contacts": every failed message with its retry status, as a CSV. Read only. */
export async function GET(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const access = await getWorkspaceReadAccess();
  if (access === "signed-out") return new Response("Sign in required", { status: 401, headers });
  if (access !== "allowed") return new Response("Not allowed", { status: 403, headers });
  const admin = createStaffAdminClient();
  if (!admin) return new Response("Unavailable", { status: 503, headers });

  const campaignId = parseCampaignFilter(new URL(request.url).searchParams.get("campaign"));
  const lines = [HEADER.map(csvCell).join(",")];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let query = admin.from("failed_message_overview")
      .select("phone_e164,campaign_name,error_code,error_title,failed_at,attempts_made,retry_status,retry_ready_at,contact_status");
    if (campaignId) query = query.eq("campaign_id", campaignId);
    const { data, error } = await query.order("failed_at", { ascending: false }).order("failure_id").range(from, from + PAGE - 1);
    if (error) return new Response("Export failed", { status: 500, headers });
    for (const row of data ?? []) {
      lines.push([row.phone_e164, row.campaign_name, row.error_code, row.error_title, row.failed_at, row.attempts_made,
        row.retry_status, row.retry_status === "eligible" || row.retry_status === "pending" ? row.retry_ready_at : "", row.contact_status]
        .map(csvCell).join(","));
    }
    if ((data?.length ?? 0) < PAGE) break;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="failed-contacts-${stamp}.csv"` },
  });
}
