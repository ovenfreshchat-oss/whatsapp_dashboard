import {
  getConfiguredMetaIdentifiers,
  getMetaConfigurationStatus,
  listMetaWebhookSubscriptions,
  MetaApiError,
} from "../meta/client";
import { sendApprovedMarketingTemplate } from "../meta/templates";
import {
  CampaignStoreError,
  getCampaignStore,
  mapClaimedRecipient,
  mapWorkerCampaign,
  type ClaimedRecipient,
} from "./store";

type SendGate = "allowed" | "suppressed" | "deferred" | "canceled" | "inactive";
type SendResult = "accepted" | "rejected" | "uncertain" | "suppressed" | "canceled" | "deferred";

export type WorkerReadiness =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      timeZone: string;
      startMinute: number;
      endMinute: number;
      days: ReadonlySet<number>;
      batchSize: number;
      intervalMs: number;
      /** Temporary cap: at most `batch` sends, then `cooldownMinutes` of silence. Null = off. */
      throttle: { batch: number; cooldownMinutes: number } | null;
    };

function parseClock(value: string | undefined): number | null {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Sending requires an explicit on switch and complete local-time policy. */
export function getCampaignWorkerReadiness(): WorkerReadiness {
  if (process.env.WHATSAPP_SENDS_ENABLED !== "true") {
    return { enabled: false, reason: "Sending is disabled." };
  }
  if (!getMetaConfigurationStatus().configured || !process.env.META_APP_ID?.trim() ||
      !process.env.META_APP_SECRET?.trim() ||
      !process.env.META_WEBHOOK_VERIFY_TOKEN?.trim()) {
    return { enabled: false, reason: "Meta sending and webhook configuration is incomplete." };
  }
  const timeZone = process.env.WHATSAPP_SEND_TIME_ZONE?.trim();
  const startMinute = parseClock(process.env.WHATSAPP_SEND_WINDOW_START);
  const endMinute = parseClock(process.env.WHATSAPP_SEND_WINDOW_END);
  const daysValue = process.env.WHATSAPP_SEND_DAYS?.trim();
  if (!timeZone || startMinute === null || endMinute === null ||
      startMinute >= endMinute || !daysValue || !/^[0-6](?:\s*,\s*[0-6])*$/.test(daysValue)) {
    return { enabled: false, reason: "An explicit sending window and days policy is required." };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    return { enabled: false, reason: "The sending time zone is invalid." };
  }

  const batchSize = Number(process.env.WHATSAPP_WORKER_BATCH_SIZE ?? "5");
  const intervalMs = Number(process.env.WHATSAPP_MIN_INTERVAL_MS ?? "1000");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 25 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 200 || intervalMs > 60000) {
    return { enabled: false, reason: "Worker batch or rate configuration is invalid." };
  }
  // Optional temporary throttle. Both values must be set together; unset both to turn it off.
  const throttleBatchRaw = process.env.WHATSAPP_THROTTLE_BATCH?.trim();
  const throttleCooldownRaw = process.env.WHATSAPP_THROTTLE_COOLDOWN_MINUTES?.trim();
  let throttle: { batch: number; cooldownMinutes: number } | null = null;
  if (throttleBatchRaw || throttleCooldownRaw) {
    const batch = Number(throttleBatchRaw);
    const cooldownMinutes = Number(throttleCooldownRaw);
    if (!throttleBatchRaw || !throttleCooldownRaw ||
        !Number.isSafeInteger(batch) || batch < 1 || batch > 500 ||
        !Number.isSafeInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 1440) {
      return {
        enabled: false,
        reason: "The send throttle needs both WHATSAPP_THROTTLE_BATCH (1-500) and WHATSAPP_THROTTLE_COOLDOWN_MINUTES (1-1440).",
      };
    }
    throttle = { batch, cooldownMinutes };
  }
  return {
    enabled: true,
    timeZone,
    startMinute,
    endMinute,
    days: new Set(daysValue.split(",").map((value) => Number(value.trim()))),
    batchSize,
    intervalMs,
    throttle,
  };
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function isWithinCampaignSendWindow(
  policy: Extract<WorkerReadiness, { enabled: true }>,
  instant = new Date(),
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: policy.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const day = WEEKDAYS[value("weekday") ?? ""];
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  return policy.days.has(day) && minutes >= policy.startMinute && minutes < policy.endMinute;
}

function nonemptyErrorSummary(error: unknown): string {
  // Only our own safe errors may be persisted. Provider raw messages are excluded.
  if (error instanceof MetaApiError) return error.message.slice(0, 500);
  return "Campaign send could not be completed.";
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getCampaignStore().rpc(name, args);
  if (error) throw new CampaignStoreError("Campaign worker storage operation failed.");
  return data as T;
}

async function sendGate(recipientId: string): Promise<SendGate> {
  const gate = await rpc<unknown>("whatsapp_campaign_send_gate", { p_recipient_id: recipientId });
  if (!["allowed", "suppressed", "deferred", "canceled", "inactive"].includes(String(gate))) {
    throw new CampaignStoreError("Campaign send gate returned an invalid result.");
  }
  return gate as SendGate;
}

async function recordResult(
  recipientId: string,
  state: SendResult,
  messageId: string | null,
  summary: string | null,
): Promise<void> {
  await rpc("record_whatsapp_campaign_send_result", {
    p_recipient_id: recipientId,
    p_state: state,
    p_wamid: messageId,
    p_error_summary: summary,
  });
}

async function handleGate(recipientId: string, gate: Exclude<SendGate, "allowed">): Promise<void> {
  if (gate === "inactive") {
    await recordResult(recipientId, "deferred", null, "Campaign claim changed before send.");
  } else {
    await recordResult(recipientId, gate, null,
      gate === "suppressed" ? "Recipient is no longer eligible." : "Campaign is not running.");
  }
}

async function pauseForReview(campaignId: string, reason: string): Promise<void> {
  await rpc("worker_pause_whatsapp_campaign", {
    p_campaign_id: campaignId,
    p_reason: reason,
  });
}

async function processRecipient(
  recipient: ClaimedRecipient,
  policy: Extract<WorkerReadiness, { enabled: true }>,
): Promise<SendResult> {
  const store = getCampaignStore();
  const { data, error } = await store.from("whatsapp_campaigns")
    .select("id,state,waba_id,phone_number_id,template_id,template_name,template_language,template_snapshot,body_parameters,header_media_url")
    .eq("id", recipient.campaignId).single();
  if (error || !data) throw new CampaignStoreError("Claimed campaign could not be loaded.");
  const campaign = mapWorkerCampaign(data);
  const configured = getConfiguredMetaIdentifiers();
  if (campaign.wabaId !== configured.wabaId ||
      campaign.phoneNumberId !== configured.phoneNumberId) {
    await recordResult(recipient.id, "deferred", null, "Configured sender changed.");
    await pauseForReview(campaign.id, "Configured sender changed");
    return "deferred";
  }

  const initialGate = await sendGate(recipient.id);
  if (initialGate !== "allowed") {
    await handleGate(recipient.id, initialGate);
    return initialGate === "inactive" ? "deferred" : initialGate;
  }

  const waitMs = await rpc<number>("reserve_whatsapp_sender_slot", {
    p_waba_id: campaign.wabaId,
    p_phone_number_id: campaign.phoneNumberId,
    p_interval_ms: policy.intervalMs,
  });
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new CampaignStoreError("Sender rate reservation was invalid.");
  }
  if (waitMs > 60_000) {
    await recordResult(recipient.id, "deferred", null, "Sender rate backlog is high.");
    return "deferred";
  }
  if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

  let finalGate: SendGate = "allowed";
  let postReady = false;
  let acceptedMessageId: string;
  try {
    const result = await sendApprovedMarketingTemplate({
      recipientE164: recipient.recipientE164,
      templateName: campaign.templateName,
      languageCode: campaign.templateLanguage,
      expectedTemplateId: campaign.templateId,
      expectedTemplateSnapshot: campaign.templateSnapshot,
      bodyParameters: campaign.bodyParameters,
      headerMediaUrl: campaign.headerMediaUrl ?? undefined,
      beforeSend: async () => {
        if (process.env.WHATSAPP_SENDS_ENABLED !== "true" ||
            !isWithinCampaignSendWindow(policy)) {
          finalGate = "deferred";
          throw new Error("Sending window is closed.");
        }
        finalGate = await sendGate(recipient.id);
        if (finalGate !== "allowed") throw new Error("Recipient is no longer sendable.");
        postReady = true;
      },
    });
    acceptedMessageId = result.messageId;
  } catch (error) {
    if (finalGate !== "allowed") {
      const state = finalGate === "inactive" ? "deferred" : finalGate;
      await recordResult(recipient.id, state, null, "Final eligibility check stopped the send.");
      return state;
    }
    if (!postReady) {
      // This failed during Meta/template preflight. No POST was made.
      await recordResult(recipient.id, "deferred", null, nonemptyErrorSummary(error));
      await pauseForReview(campaign.id, "Meta template preflight failed");
      return "deferred";
    }
    const state: SendResult =
      error instanceof MetaApiError && error.definitiveRejection ? "rejected" : "uncertain";
    await recordResult(recipient.id, state, null, nonemptyErrorSummary(error));
    return state;
  }
  // Recording is outside the send catch: a database error after Meta accepted
  // must never be mistaken for a send failure or trigger another API call.
  await recordResult(recipient.id, "accepted", acceptedMessageId, null);
  return "accepted";
}

export type CampaignWorkerTick = {
  enabled: boolean;
  reason?: string;
  /** Set while the temporary send throttle is cooling down: nothing is sent before this time. */
  throttledUntil?: string;
  claimed: number;
  outcomes: Record<SendResult, number>;
};

export async function runCampaignWorkerTick(): Promise<CampaignWorkerTick> {
  const outcomes: Record<SendResult, number> = {
    accepted: 0, rejected: 0, uncertain: 0, suppressed: 0, canceled: 0, deferred: 0,
  };
  const policy = getCampaignWorkerReadiness();
  if (!policy.enabled) return { enabled: false, reason: policy.reason, claimed: 0, outcomes };
  if (!isWithinCampaignSendWindow(policy)) {
    return { enabled: false, reason: "Outside the configured sending window.", claimed: 0, outcomes };
  }
  const subscription = await listMetaWebhookSubscriptions();
  if (subscription.isCurrentAppSubscribed !== true) {
    return { enabled: false, reason: "The configured app is not subscribed to WABA webhooks.",
      claimed: 0, outcomes };
  }

  await rpc("mark_stale_whatsapp_campaign_claims", {});
  let claimLimit = policy.batchSize;
  if (policy.throttle) {
    const allowance = await rpc<{ allowed?: unknown; wait_until?: unknown }>("campaign_send_throttle", {
      p_batch: policy.throttle.batch,
      p_cooldown_minutes: policy.throttle.cooldownMinutes,
    });
    const allowed = allowance?.allowed;
    if (typeof allowed !== "number" || !Number.isSafeInteger(allowed) || allowed < 0) {
      throw new CampaignStoreError("Send throttle returned invalid data.");
    }
    if (allowed === 0) {
      const until = typeof allowance.wait_until === "string" ? allowance.wait_until : undefined;
      return { enabled: true, claimed: 0, throttledUntil: until, outcomes };
    }
    claimLimit = Math.min(claimLimit, allowed);
  }
  const claimedData = await rpc<unknown[]>("claim_whatsapp_campaign_recipients", {
    p_limit: claimLimit,
  });
  if (!Array.isArray(claimedData)) {
    throw new CampaignStoreError("Campaign claim returned invalid data.");
  }
  const claimed = claimedData.map(mapClaimedRecipient);
  for (const recipient of claimed) {
    const result = await processRecipient(recipient, policy);
    outcomes[result] += 1;
  }
  await rpc("finish_whatsapp_campaigns", {});
  return { enabled: true, claimed: claimed.length, outcomes };
}
