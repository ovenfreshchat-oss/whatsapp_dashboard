import { createStaffAdminClient } from "@/server/auth/staff-users/admin";

export type FailedSummary = {
  total: number;
  eligible: number;
  eligibleReady: number;
  pending: number;
  recovered: number;
  exhausted: number;
  stopped: number;
  notRetryable: number;
  byCode: { code: string; title: string | null; count: number }[];
};

export type FailedRow = {
  failureId: string;
  campaignId: string;
  campaignName: string;
  phone: string;
  errorCode: string;
  errorTitle: string | null;
  failedAt: string;
  attemptsMade: number;
  lastAttemptAt: string | null;
  retryStatus: "recovered" | "pending" | "exhausted" | "stopped" | "eligible" | "not_retryable";
  retryReadyAt: string | null;
  contactStatus: string | null;
};

export type ReviewRow = { phone: string; reason: string | null; holdUntil: string | null; reviewDueAt: string | null };
export type CampaignOption = { id: string; name: string; autoRetry: boolean; delays: number[]; state: string };
export type SenderAlert = { id: string; code: string; title: string | null; occurrences: number; firstSeenAt: string };

export const RETRY_STATUSES = ["eligible", "pending", "recovered", "exhausted", "stopped", "not_retryable"] as const;
export type RetryStatusFilter = (typeof RETRY_STATUSES)[number];

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : null);
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function parseCampaignFilter(value: unknown): string | null {
  return isUuid(value) ? value : null;
}
export function parseStatusFilter(value: unknown): RetryStatusFilter | null {
  return typeof value === "string" && (RETRY_STATUSES as readonly string[]).includes(value)
    ? (value as RetryStatusFilter) : null;
}

export function mapSummary(raw: unknown): FailedSummary {
  const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const byCode = Array.isArray(item.by_code) ? item.by_code : [];
  return {
    total: num(item.total), eligible: num(item.eligible), eligibleReady: num(item.eligible_ready),
    pending: num(item.pending), recovered: num(item.recovered), exhausted: num(item.exhausted),
    stopped: num(item.stopped), notRetryable: num(item.not_retryable),
    byCode: byCode.map((entry) => {
      const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      return { code: str(e.code) ?? "unknown", title: str(e.title), count: num(e.count) };
    }),
  };
}

export function mapFailedRow(raw: Record<string, unknown>): FailedRow {
  return {
    failureId: String(raw.failure_id), campaignId: String(raw.campaign_id),
    campaignName: str(raw.campaign_name) ?? "Campaign", phone: String(raw.phone_e164),
    errorCode: String(raw.error_code), errorTitle: str(raw.error_title), failedAt: String(raw.failed_at),
    attemptsMade: num(raw.attempts_made), lastAttemptAt: str(raw.last_attempt_at),
    retryStatus: (parseStatusFilter(raw.retry_status) ?? "not_retryable"),
    retryReadyAt: str(raw.retry_ready_at), contactStatus: str(raw.contact_status),
  };
}

export type FailedOverview = {
  ready: boolean;
  summary: FailedSummary;
  rows: FailedRow[];
  rowCount: number;
  campaigns: CampaignOption[];
  review: ReviewRow[];
  reviewCount: number;
  alerts: SenderAlert[];
};

const EMPTY: FailedSummary = {
  total: 0, eligible: 0, eligibleReady: 0, pending: 0, recovered: 0, exhausted: 0, stopped: 0, notRetryable: 0, byCode: [],
};

export async function loadFailedOverview(options: {
  campaignId: string | null; status: RetryStatusFilter | null; page: number; pageSize: number;
}): Promise<FailedOverview> {
  const empty: FailedOverview = { ready: false, summary: EMPTY, rows: [], rowCount: 0, campaigns: [], review: [], reviewCount: 0, alerts: [] };
  const admin = createStaffAdminClient();
  if (!admin) return empty;

  let rowsQuery = admin.from("failed_message_overview")
    .select("failure_id,campaign_id,campaign_name,phone_e164,error_code,error_title,failed_at,attempts_made,last_attempt_at,retry_status,retry_ready_at,contact_status", { count: "exact" });
  if (options.campaignId) rowsQuery = rowsQuery.eq("campaign_id", options.campaignId);
  if (options.status) rowsQuery = rowsQuery.eq("retry_status", options.status);
  const first = (options.page - 1) * options.pageSize;

  const [summary, rows, campaigns, review, alerts] = await Promise.all([
    admin.rpc("failed_message_summary", { p_campaign_id: options.campaignId }),
    rowsQuery.order("failed_at", { ascending: false }).order("failure_id").range(first, first + options.pageSize - 1),
    admin.from("whatsapp_campaigns").select("id,name,auto_retry,retry_delays_hours,state").order("created_at", { ascending: false }).limit(50),
    admin.from("contact_delivery_status").select("phone_e164,reason,hold_until,review_due_at", { count: "exact" })
      .eq("status", "do_not_send").order("review_due_at", { ascending: true, nullsFirst: false }).limit(50),
    admin.from("sender_alerts").select("id,code,title,occurrences,first_seen_at").is("resolved_at", null).order("first_seen_at", { ascending: false }).limit(5),
  ]);
  if (summary.error || rows.error || campaigns.error) return empty;

  return {
    ready: true,
    summary: mapSummary(summary.data),
    rows: (rows.data ?? []).map((r) => mapFailedRow(r as Record<string, unknown>)),
    rowCount: rows.count ?? 0,
    campaigns: (campaigns.data ?? []).map((c) => ({
      id: String(c.id), name: String(c.name), autoRetry: c.auto_retry === true,
      delays: Array.isArray(c.retry_delays_hours) ? c.retry_delays_hours.map(Number) : [24, 72, 168], state: String(c.state),
    })),
    review: review.error ? [] : (review.data ?? []).map((r) => ({
      phone: String(r.phone_e164), reason: str(r.reason), holdUntil: str(r.hold_until), reviewDueAt: str(r.review_due_at),
    })),
    reviewCount: review.error ? 0 : review.count ?? 0,
    alerts: alerts.error ? [] : (alerts.data ?? []).map((a) => ({
      id: String(a.id), code: String(a.code), title: str(a.title), occurrences: num(a.occurrences), firstSeenAt: String(a.first_seen_at),
    })),
  };
}

/** Unresolved business-number restrictions (131048), for the banner on the dashboard and campaigns. */
export async function loadOpenSenderAlerts(): Promise<SenderAlert[]> {
  const admin = createStaffAdminClient();
  if (!admin) return [];
  const { data, error } = await admin.from("sender_alerts")
    .select("id,code,title,occurrences,first_seen_at").is("resolved_at", null).order("first_seen_at", { ascending: false }).limit(5);
  if (error) return [];
  return (data ?? []).map((a) => ({
    id: String(a.id), code: String(a.code), title: str(a.title), occurrences: num(a.occurrences), firstSeenAt: String(a.first_seen_at),
  }));
}

export type AudienceReview = {
  pool: number; eligible: number; excluded: number; optOut: number; doNotSend: number; other: number;
  atRiskEligible: number; inCampaign: number; willSkipAtSend: number;
};

/** Eligible and excluded counts for a campaign, so nobody sends blind. Null when unavailable. */
export async function loadAudienceReview(campaignId: string): Promise<AudienceReview | null> {
  const admin = createStaffAdminClient();
  if (!admin || !isUuid(campaignId)) return null;
  const { data, error } = await admin.rpc("campaign_audience_review", { p_campaign_id: campaignId });
  if (error || !data || typeof data !== "object") return null;
  const item = data as Record<string, unknown>;
  return {
    pool: num(item.pool), eligible: num(item.eligible), excluded: num(item.excluded), optOut: num(item.opt_out),
    doNotSend: num(item.do_not_send), other: num(item.other), atRiskEligible: num(item.at_risk_eligible),
    inCampaign: num(item.in_campaign), willSkipAtSend: num(item.will_skip_at_send),
  };
}
