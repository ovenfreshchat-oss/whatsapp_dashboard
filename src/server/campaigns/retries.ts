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
  recipientId: string;
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
  contactReason: string | null;
};

export type SenderAlert = { id: string; code: string; title: string | null; occurrences: number; firstSeenAt: string };

export const RETRY_STATUSES = ["eligible", "pending", "recovered", "exhausted", "stopped", "not_retryable"] as const;
export type RetryStatusFilter = (typeof RETRY_STATUSES)[number];

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : null);
export const isUuid = (value: unknown): value is string =>
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
    failureId: String(raw.failure_id), recipientId: String(raw.recipient_id), campaignId: String(raw.campaign_id),
    campaignName: str(raw.campaign_name) ?? "Campaign", phone: String(raw.phone_e164),
    errorCode: String(raw.error_code), errorTitle: str(raw.error_title), failedAt: String(raw.failed_at),
    attemptsMade: num(raw.attempts_made), lastAttemptAt: str(raw.last_attempt_at),
    retryStatus: (parseStatusFilter(raw.retry_status) ?? "not_retryable"),
    retryReadyAt: str(raw.retry_ready_at), contactStatus: str(raw.contact_status), contactReason: str(raw.contact_reason),
  };
}

export type RetryAttempt = {
  attempt: number; trigger: string; state: string; deliveryStatus: string | null;
  scheduledFor: string; sentAt: string | null; errorCode: string | null;
};
export type NewCampaignCheck = { eligible: boolean; reason: string | null; readyAt: string | null };
export type FailedRowDetail = FailedRow & {
  name: string | null;
  history: RetryAttempt[];
  newCampaign: NewCampaignCheck;
};

export type CampaignFailures = {
  ready: boolean;
  summary: FailedSummary;
  rows: FailedRowDetail[];
  rowCount: number;
  campaign: { id: string; name: string; state: string; autoRetry: boolean; delays: number[] } | null;
};

const EMPTY: FailedSummary = {
  total: 0, eligible: 0, eligibleReady: 0, pending: 0, recovered: 0, exhausted: 0, stopped: 0, notRetryable: 0, byCode: [],
};

/** Everything the campaign's Failed Messages tab shows: counts, one page of rows with names, retry history and eligibility. */
export async function loadCampaignFailures(options: {
  campaignId: string; status: RetryStatusFilter | null; page: number; pageSize: number;
}): Promise<CampaignFailures> {
  const empty: CampaignFailures = { ready: false, summary: EMPTY, rows: [], rowCount: 0, campaign: null };
  const admin = createStaffAdminClient();
  if (!admin || !isUuid(options.campaignId)) return empty;

  let rowsQuery = admin.from("failed_message_overview")
    .select("failure_id,recipient_id,campaign_id,campaign_name,phone_e164,error_code,error_title,failed_at,attempts_made,last_attempt_at,retry_status,retry_ready_at,contact_status,contact_reason", { count: "exact" })
    .eq("campaign_id", options.campaignId);
  if (options.status) rowsQuery = rowsQuery.eq("retry_status", options.status);
  const first = (options.page - 1) * options.pageSize;

  const [summary, rows, campaign] = await Promise.all([
    admin.rpc("failed_message_summary", { p_campaign_id: options.campaignId }),
    rowsQuery.order("failed_at", { ascending: false }).order("failure_id").range(first, first + options.pageSize - 1),
    admin.from("whatsapp_campaigns").select("id,name,auto_retry,retry_delays_hours,state").eq("id", options.campaignId).maybeSingle(),
  ]);
  if (summary.error || rows.error || campaign.error || !campaign.data) return empty;

  const base = (rows.data ?? []).map((r) => mapFailedRow(r as Record<string, unknown>));
  const failureIds = base.map((r) => r.failureId);
  const recipientIds = base.map((r) => r.recipientId);
  const phones = [...new Set(base.map((r) => r.phone))];

  const [names, history, eligibility] = base.length
    ? await Promise.all([
      admin.from("contacts").select("phone_e164,display_name").in("phone_e164", phones),
      admin.from("campaign_message_retries")
        .select("recipient_id,attempt_number,trigger,state,delivery_status,scheduled_for,claimed_at,error_code")
        .in("recipient_id", recipientIds).order("attempt_number"),
      admin.rpc("failed_contact_eligibility", { p_campaign_id: options.campaignId, p_failure_ids: failureIds }),
    ])
    : [null, null, null];

  const nameByPhone = new Map<string, string | null>();
  for (const c of names?.data ?? []) nameByPhone.set(String(c.phone_e164), str(c.display_name));
  const historyByRecipient = new Map<string, RetryAttempt[]>();
  for (const h of history?.data ?? []) {
    const list = historyByRecipient.get(String(h.recipient_id)) ?? [];
    list.push({
      attempt: num(h.attempt_number), trigger: String(h.trigger), state: String(h.state), deliveryStatus: str(h.delivery_status),
      scheduledFor: String(h.scheduled_for), sentAt: str(h.claimed_at), errorCode: str(h.error_code),
    });
    historyByRecipient.set(String(h.recipient_id), list);
  }
  const checkByFailure = new Map<string, NewCampaignCheck>();
  if (!eligibility?.error) {
    for (const e of (eligibility?.data ?? []) as Record<string, unknown>[]) {
      checkByFailure.set(String(e.failure_id), { eligible: e.eligible === true, reason: str(e.reason), readyAt: str(e.ready_at) });
    }
  }

  return {
    ready: true,
    summary: mapSummary(summary.data),
    rows: base.map((r) => ({
      ...r,
      name: nameByPhone.get(r.phone) ?? null,
      history: historyByRecipient.get(r.recipientId) ?? [],
      newCampaign: checkByFailure.get(r.failureId) ?? { eligible: false, reason: "not_allowed_marketing", readyAt: null },
    })),
    rowCount: rows.count ?? 0,
    campaign: {
      id: String(campaign.data.id), name: String(campaign.data.name), state: String(campaign.data.state),
      autoRetry: campaign.data.auto_retry === true,
      delays: Array.isArray(campaign.data.retry_delays_hours) ? campaign.data.retry_delays_hours.map(Number) : [24, 72, 168],
    },
  };
}

export type FailedContactPreview = {
  selected: number; eligible: number; excluded: number; reasons: Record<string, number>; readyAt: string | null;
};

/** Eligible and excluded counts for a "new campaign from failed contacts" selection (null ids = every failed contact). */
export async function previewFailedContacts(campaignId: string, failureIds: string[] | null): Promise<FailedContactPreview | null> {
  const admin = createStaffAdminClient();
  if (!admin || !isUuid(campaignId) || (failureIds !== null && !failureIds.every(isUuid))) return null;
  const { data, error } = await admin.rpc("preview_failed_contact_campaign", { p_campaign_id: campaignId, p_failure_ids: failureIds });
  if (error || !data || typeof data !== "object") return null;
  const item = data as Record<string, unknown>;
  const reasons: Record<string, number> = {};
  if (item.reasons && typeof item.reasons === "object") {
    for (const [key, value] of Object.entries(item.reasons as Record<string, unknown>)) reasons[key] = num(value);
  }
  return { selected: num(item.selected), eligible: num(item.eligible), excluded: num(item.excluded), reasons, readyAt: str(item.ready_at) };
}

export type DeliveryOverview = {
  totalSent: number; delivered: number; failed: number; deliveryRate: number;
  retryPending: number; recovered: number; retryExhausted: number;
};

/** Dashboard totals across campaigns. Dates are YYYY-MM-DD (inclusive); null leaves that side open. */
export function parseDateParam(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}

export async function loadDeliveryOverview(options: {
  from: string | null; to: string | null; campaignId: string | null;
}): Promise<DeliveryOverview | null> {
  const admin = createStaffAdminClient();
  if (!admin) return null;
  const toExclusive = options.to ? new Date(Date.parse(`${options.to}T00:00:00Z`) + 86_400_000).toISOString() : null;
  const { data, error } = await admin.rpc("delivery_overview", {
    p_from: options.from ? `${options.from}T00:00:00Z` : null, p_to: toExclusive, p_campaign_id: options.campaignId,
  });
  if (error || !data || typeof data !== "object") return null;
  const item = data as Record<string, unknown>;
  return {
    totalSent: num(item.total_sent), delivered: num(item.delivered), failed: num(item.failed), deliveryRate: num(item.delivery_rate),
    retryPending: num(item.retry_pending), recovered: num(item.recovered), retryExhausted: num(item.retry_exhausted),
  };
}

export async function listCampaignChoices(): Promise<{ id: string; name: string }[]> {
  const admin = createStaffAdminClient();
  if (!admin) return [];
  const { data, error } = await admin.from("whatsapp_campaigns").select("id,name").neq("state", "draft")
    .order("created_at", { ascending: false }).limit(100);
  return error ? [] : (data ?? []).map((c) => ({ id: String(c.id), name: String(c.name) }));
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
