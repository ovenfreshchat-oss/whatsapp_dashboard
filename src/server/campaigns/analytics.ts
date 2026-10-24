import { getConfiguredMetaIdentifiers, metaGraphGet } from "@/server/meta/client";
import { requireAdminActor } from "./admin";
import { assertCampaignId, CampaignStoreError, getCampaignStore } from "./store";

export type CampaignAnalytics = {
  campaign: {
    id: string; name: string; state: string; templateId: string; templateName: string;
    scheduledFor: string | null; createdAt: string;
  };
  audience: number; attempted: number; accepted: number; rejected: number; uncertain: number;
  suppressed: number; canceled: number; pending: number;
  sent: number; delivered: number; read: number; failed: number; noStatus: number; conflicts: number;
  firstAcceptedAt: string | null; lastAcceptedAt: string | null; lastStatusAt: string | null;
  medianDeliveredSeconds: number | null; medianReadSeconds: number | null;
  failureReasons: { code: string; title: string; total: number }[];
  rejectionReasons: { reason: string; total: number }[];
  replies: number; repliers: number; optOuts: number;
  timeline: { hour: string; accepted: number; delivered: number; read: number }[];
};

export type MetaTemplateStats = { sent: number; delivered: number; read: number; from: string; to: string } | null;

type Row = Record<string, unknown>;
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const numOrNull = (value: unknown) => (value === null || value === undefined ? null : num(value));
const str = (value: unknown) => (typeof value === "string" ? value : null);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((v): v is Row => !!v && typeof v === "object") : []);

export async function getCampaignAnalytics(id: string): Promise<CampaignAnalytics> {
  await requireAdminActor();
  assertCampaignId(id);
  const store = getCampaignStore();
  const [campaignResult, analyticsResult] = await Promise.all([
    store.from("whatsapp_campaigns")
      .select("id,name,state,template_id,template_name,scheduled_for,created_at").eq("id", id).single(),
    store.rpc("whatsapp_campaign_analytics", { p_campaign_id: id }),
  ]);
  const c = campaignResult.data as Row | null;
  const a = analyticsResult.data as Row | null;
  if (campaignResult.error || !c || analyticsResult.error || !a) {
    throw new CampaignStoreError("Campaign analytics could not be loaded. Apply drizzle/0016_campaign_analytics.sql.");
  }
  return {
    campaign: {
      id: String(c.id), name: String(c.name), state: String(c.state), templateId: String(c.template_id),
      templateName: String(c.template_name), scheduledFor: str(c.scheduled_for), createdAt: String(c.created_at),
    },
    audience: num(a.audience), attempted: num(a.attempted), accepted: num(a.accepted),
    rejected: num(a.rejected), uncertain: num(a.uncertain), suppressed: num(a.suppressed),
    canceled: num(a.canceled), pending: num(a.pending),
    sent: num(a.sent), delivered: num(a.delivered), read: num(a.read), failed: num(a.failed),
    noStatus: num(a.no_status), conflicts: num(a.conflicts),
    firstAcceptedAt: str(a.first_accepted_at), lastAcceptedAt: str(a.last_accepted_at),
    lastStatusAt: str(a.last_status_at),
    medianDeliveredSeconds: numOrNull(a.median_delivered_seconds),
    medianReadSeconds: numOrNull(a.median_read_seconds),
    failureReasons: rows(a.failure_reasons).map((r) => ({ code: String(r.code), title: String(r.title), total: num(r.total) })),
    rejectionReasons: rows(a.rejection_reasons).map((r) => ({ reason: String(r.reason), total: num(r.total) })),
    replies: num(a.replies), repliers: num(a.repliers), optOuts: num(a.opt_outs),
    timeline: rows(a.timeline).map((r) => ({
      hour: String(r.hour), accepted: num(r.accepted), delivered: num(r.delivered), read: num(r.read),
    })),
  };
}

/**
 * Meta's own counts for this template over the campaign's days. They cover every send of the
 * template (not only this campaign) and can lag a day, so they are a cross-check, not the source.
 */
export async function getMetaTemplateStats(analytics: CampaignAnalytics): Promise<MetaTemplateStats> {
  if (!analytics.firstAcceptedAt) return null;
  try {
    getConfiguredMetaIdentifiers();
    const dayMs = 86_400_000;
    const start = Math.floor((Date.parse(analytics.firstAcceptedAt) - dayMs) / 1000);
    const end = Math.floor(Math.min(Date.now(), Date.parse(analytics.lastAcceptedAt ?? analytics.firstAcceptedAt) + 2 * dayMs) / 1000);
    const { wabaId } = getConfiguredMetaIdentifiers();
    const query = new URLSearchParams({
      start: String(start), end: String(end), granularity: "DAILY",
      template_ids: JSON.stringify([analytics.campaign.templateId]),
      metric_types: JSON.stringify(["SENT", "DELIVERED", "READ"]),
    });
    const payload = await metaGraphGet(`${wabaId}/template_analytics`, query);
    let sent = 0, delivered = 0, read = 0;
    for (const entry of rows(payload.data)) {
      for (const point of rows(entry.data_points)) {
        sent += num(point.sent); delivered += num(point.delivered); read += num(point.read);
      }
    }
    return { sent, delivered, read, from: new Date(start * 1000).toISOString().slice(0, 10), to: new Date(end * 1000).toISOString().slice(0, 10) };
  } catch {
    return null;
  }
}
