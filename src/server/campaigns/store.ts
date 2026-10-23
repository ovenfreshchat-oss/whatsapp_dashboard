import { createClient } from "@supabase/supabase-js";

export class CampaignStoreError extends Error {
  constructor(message = "Campaign storage is unavailable.") {
    super(message);
    this.name = "CampaignStoreError";
  }
}

/** Service role only. Never import this client into browser code. */
export function getCampaignStore() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) throw new CampaignStoreError("Campaign storage is not configured.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function assertCampaignId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new CampaignStoreError("Campaign ID is invalid.");
  }
}

export type CampaignState =
  | "draft"
  | "scheduled"
  | "running"
  | "paused"
  | "canceled"
  | "completed";

export type CampaignSummary = {
  id: string;
  name: string;
  state: CampaignState;
  audienceSource: "import_batch" | "all_eligible";
  importBatchId: string | null;
  audienceSourceLabel: string;
  templateName: string;
  templateLanguage: string;
  scheduledFor: string | null;
  audienceCount: number;
  createdAt: string;
};

export type CampaignCounts = Record<
  | "pending" | "in_flight" | "accepted" | "rejected" | "uncertain"
  | "suppressed" | "canceled" | "sent" | "delivered" | "read"
  | "failed" | "delivery_conflict",
  number
>;

export type CampaignAuditEntry = {
  action: string;
  createdAt: string;
  reviewedAudienceCount: number | null;
  audienceSourceLabel: string | null;
};

export type CampaignDetail = CampaignSummary & {
  counts: CampaignCounts;
  audit: CampaignAuditEntry[];
  reviewSha256: string;
  templateBody: string;
  templateComponents: CampaignTemplateComponentReview[];
  bodyParameters: string[];
  headerMediaUrl: string | null;
  recipientPreview: CampaignRecipientPreview[];
};

export type CampaignTemplateComponentReview = {
  type: string;
  format: string | null;
  text: string | null;
  buttons: { type: string | null; text: string | null; url: string | null;
    phoneNumber: string | null }[];
};

export type CampaignRecipientPreview = {
  contactId: string;
  displayName: string | null;
  phoneE164: string;
  state: string;
};

type DbRow = Record<string, unknown>;

function row(value: unknown): DbRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CampaignStoreError("Campaign storage returned invalid data.");
  }
  return value as DbRow;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new CampaignStoreError("Campaign storage returned invalid data.");
  return value;
}

export function mapCampaign(value: unknown): CampaignSummary {
  const item = row(value);
  const state = string(item.state);
  const audienceSource = string(item.audience_source);
  if (!["draft", "scheduled", "running", "paused", "canceled", "completed"].includes(state)) {
    throw new CampaignStoreError("Campaign storage returned an invalid state.");
  }
  if (audienceSource !== "import_batch" && audienceSource !== "all_eligible") {
    throw new CampaignStoreError("Campaign storage returned an invalid audience source.");
  }
  return {
    id: string(item.id),
    name: string(item.name),
    state: state as CampaignState,
    audienceSource,
    importBatchId: item.import_batch_id === null ? null : string(item.import_batch_id),
    audienceSourceLabel: string(item.audience_source_label),
    templateName: string(item.template_name),
    templateLanguage: string(item.template_language),
    scheduledFor: item.scheduled_for === null ? null : string(item.scheduled_for),
    audienceCount: Number(item.audience_count),
    createdAt: string(item.created_at),
  };
}

const COUNT_KEYS = [
  "pending", "in_flight", "accepted", "rejected", "uncertain", "suppressed",
  "canceled", "sent", "delivered", "read", "failed", "delivery_conflict",
] as const;

export function mapCounts(value: unknown): CampaignCounts {
  const item = row(value);
  const counts = {} as CampaignCounts;
  for (const key of COUNT_KEYS) {
    const count = Number(item[key] ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new CampaignStoreError("Campaign storage returned invalid counts.");
    }
    counts[key] = count;
  }
  return counts;
}

export function mapAudit(value: unknown): CampaignAuditEntry {
  const item = row(value);
  const detail = item.detail && typeof item.detail === "object" &&
    !Array.isArray(item.detail) ? item.detail as DbRow : {};
  const count = detail.review_acknowledged === true
    ? Number(detail.review_audience_count) : null;
  return {
    action: string(item.action),
    createdAt: string(item.created_at),
    reviewedAudienceCount: count !== null && Number.isSafeInteger(count) && count >= 0
      ? count : null,
    audienceSourceLabel: typeof detail.audience_source_label === "string"
      ? detail.audience_source_label : null,
  };
}

export function mapCampaignTemplateReview(value: unknown): {
  reviewSha256: string;
  templateBody: string;
  templateComponents: CampaignTemplateComponentReview[];
  bodyParameters: string[];
  headerMediaUrl: string | null;
} {
  const item = row(value);
  const snapshot = row(item.template_snapshot);
  const reviewSha256 = string(item.review_sha256);
  if (!/^[0-9a-f]{64}$/.test(reviewSha256)) {
    throw new CampaignStoreError("Campaign review fingerprint is invalid.");
  }
  if (!Array.isArray(snapshot.components) || !Array.isArray(item.body_parameters) ||
      !item.body_parameters.every((part) => typeof part === "string" && part.length <= 1024)) {
    throw new CampaignStoreError("Campaign template review is unavailable.");
  }
  const templateComponents = snapshot.components.map((part): CampaignTemplateComponentReview => {
    const component = row(part);
    if (typeof component.type !== "string" ||
        (component.text !== null && typeof component.text !== "string") ||
        !Array.isArray(component.buttons)) {
      throw new CampaignStoreError("Campaign template review is unavailable.");
    }
    return {
      type: component.type,
      format: typeof component.format === "string" ? component.format : null,
      text: component.text,
      buttons: component.buttons.map((part) => {
        const button = row(part);
        for (const key of ["type", "text", "url", "phoneNumber"] as const) {
          if (button[key] !== null && typeof button[key] !== "string") {
            throw new CampaignStoreError("Campaign template review is unavailable.");
          }
        }
        return {
          type: button.type as string | null,
          text: button.text as string | null,
          url: button.url as string | null,
          phoneNumber: button.phoneNumber as string | null,
        };
      }),
    };
  });
  const body = templateComponents.find((part) => part.type === "BODY")?.text;
  if (typeof body !== "string" || body.length > 16384) {
    throw new CampaignStoreError("Campaign template review is unavailable.");
  }
  const headerMediaUrl = typeof item.header_media_url === "string" && item.header_media_url ? item.header_media_url : null;
  return { reviewSha256, templateBody: body, templateComponents,
    bodyParameters: item.body_parameters as string[], headerMediaUrl };
}

export function mapCampaignRecipientPreview(value: unknown): Omit<CampaignRecipientPreview, "displayName"> {
  const item = row(value);
  return {
    contactId: string(item.contact_id),
    phoneE164: string(item.recipient_e164),
    state: string(item.state),
  };
}

export type ClaimedRecipient = {
  id: string;
  campaignId: string;
  contactId: string;
  recipientE164: string;
  state: string;
};

export function mapClaimedRecipient(value: unknown): ClaimedRecipient {
  const item = row(value);
  return {
    id: string(item.id),
    campaignId: string(item.campaign_id),
    contactId: string(item.contact_id),
    recipientE164: string(item.recipient_e164),
    state: string(item.state),
  };
}

export type WorkerCampaign = {
  id: string;
  state: CampaignState;
  wabaId: string;
  phoneNumberId: string;
  templateId: string;
  templateName: string;
  templateLanguage: string;
  templateSnapshot: unknown;
  bodyParameters: string[];
  headerMediaUrl: string | null;
};

export function mapWorkerCampaign(value: unknown): WorkerCampaign {
  const item = row(value);
  if (!Array.isArray(item.body_parameters) ||
      !item.body_parameters.every((part) => typeof part === "string")) {
    throw new CampaignStoreError("Campaign storage returned invalid template values.");
  }
  const headerMediaUrl = typeof item.header_media_url === "string" && item.header_media_url ? item.header_media_url : null;
  return {
    id: string(item.id),
    state: string(item.state) as CampaignState,
    wabaId: string(item.waba_id),
    phoneNumberId: string(item.phone_number_id),
    templateId: string(item.template_id),
    templateName: string(item.template_name),
    templateLanguage: string(item.template_language),
    templateSnapshot: item.template_snapshot,
    bodyParameters: item.body_parameters as string[],
    headerMediaUrl,
  };
}
