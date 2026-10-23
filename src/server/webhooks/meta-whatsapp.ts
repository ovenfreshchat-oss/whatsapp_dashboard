import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MAX_META_WEBHOOK_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type MetaWebhookItem = {
  dedupe_key: string;
  kind: "message" | "status" | "change";
  waba_id: string;
  phone_number_id: string | null;
  field: string;
  provider_message_id: string | null;
  provider_status: string | null;
  event_timestamp: string | null;
  needs_review: boolean;
  payload: JsonObject;
};

export type MetaOptOut = {
  waba_id: string;
  phone_number_id: string;
  identity_value: string | null;
  source_item_key: string;
  source_message_id: string | null;
  /** Ambiguous wording pauses sending without recording a confirmed opt-out. */
  hold_only: boolean;
};

export type ParsedMetaWebhook = {
  payload_sha256: string;
  payload: JsonObject;
  items: MetaWebhookItem[];
  opt_outs: MetaOptOut[];
};

export class MetaWebhookPayloadError extends Error {}
export class MetaWebhookSourceError extends Error {}
export class MetaWebhookSizeError extends Error {}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = object(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function metaTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{9,10}$/.test(value)) return null;
  const seconds = Number(value);
  if (seconds < 946684800 || seconds > 4102444800) return null;
  return new Date(seconds * 1000).toISOString();
}

function normalizedOptOutText(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^[\s.!?,;:]+|[\s.!?,;:]+$/g, "")
    .replace(/[\s_-]+/g, " ")
    .toUpperCase();
}

const CLEAR_OPT_OUTS = new Set([
  "STOP",
  "STOP ALL",
  "UNSUBSCRIBE",
  "OPT OUT",
  "CANCEL",
  "END",
  "QUIT",
  "REMOVE ME",
  "NO MORE MESSAGES",
]);
const PROJECTED_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

function possibleOptOut(value: string): boolean {
  return /\b(UNSUBSCRIBE|OPT[ -]?OUT|REMOVE ME)\b/i.test(value)
    || /\b(STOP|QUIT|END|NO MORE|DON['’]?T|DO NOT)\b.{0,40}\b(MESSAG(?:E|ES|ING)|TEXT(?:S|ING)?|CONTACT|SEND|WHATSAPP|PROMOTIONS?|OFFERS?)\b/i.test(value);
}

export function classifyInboundOptOut(
  message: JsonObject,
  configuredButtonPayloads: ReadonlySet<string> = new Set(),
): "clear" | "review" | "none" {
  const text = nonemptyString(object(message.text)?.body);
  const button = object(message.button);
  const interactive = object(message.interactive);
  const buttonReply = object(interactive?.button_reply);
  const listReply = object(interactive?.list_reply);
  const buttonValues = [button?.payload, button?.text, buttonReply?.id, buttonReply?.title, listReply?.id, listReply?.title]
    .filter((value): value is string => typeof value === "string");

  if (text && CLEAR_OPT_OUTS.has(normalizedOptOutText(text))) return "clear";
  if (buttonValues.some((value) => {
    const normalized = normalizedOptOutText(value);
    return CLEAR_OPT_OUTS.has(normalized) || configuredButtonPayloads.has(value);
  })) return "clear";

  if ((text && possibleOptOut(text)) || buttonValues.some(possibleOptOut)) return "review";
  return "none";
}

export function verifyMetaToken(supplied: string | null, secret: string | undefined): boolean {
  if (!supplied || !secret) return false;
  const actual = createHash("sha256").update(supplied).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(actual, expected);
}

export function verifyMetaSignature(
  body: Uint8Array,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader || !/^sha256=[a-fA-F0-9]{64}$/.test(signatureHeader)) {
    return false;
  }
  const actual = Buffer.from(signatureHeader.slice(7), "hex");
  const expected = createHmac("sha256", appSecret).update(body).digest();
  return timingSafeEqual(actual, expected);
}

export async function readBoundedBody(request: Request, limit = MAX_META_WEBHOOK_BYTES): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new MetaWebhookSizeError("Webhook body is too large.");

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MetaWebhookSizeError("Webhook body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function parseMetaWhatsAppPayload(
  body: Uint8Array,
  expected: { wabaId: string; phoneNumberId: string; buttonPayloads?: ReadonlySet<string> },
): ParsedMetaWebhook {
  let payload: JsonObject | null;
  try {
    payload = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
  } catch {
    throw new MetaWebhookPayloadError("Webhook body is not valid JSON.");
  }
  if (!payload || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) {
    throw new MetaWebhookPayloadError("Webhook body is not a WhatsApp event.");
  }

  const items: MetaWebhookItem[] = [];
  const optOuts: MetaOptOut[] = [];
  for (const rawEntry of payload.entry) {
    const entry = object(rawEntry);
    const wabaId = nonemptyString(entry?.id);
    if (!entry || !wabaId || !Array.isArray(entry.changes)) {
      throw new MetaWebhookPayloadError("Webhook entry is malformed.");
    }
    if (wabaId !== expected.wabaId) throw new MetaWebhookSourceError("Unexpected WABA.");

    for (const rawChange of entry.changes) {
      const change = object(rawChange);
      const field = nonemptyString(change?.field);
      const value = object(change?.value);
      if (!change || !field || !value) throw new MetaWebhookPayloadError("Webhook change is malformed.");
      const phoneNumberId = nonemptyString(object(value.metadata)?.phone_number_id);
      if (phoneNumberId && phoneNumberId !== expected.phoneNumberId) {
        throw new MetaWebhookSourceError("Unexpected phone number ID.");
      }
      const rawMessages = value.messages;
      const rawStatuses = value.statuses;
      if ((rawMessages !== undefined && !Array.isArray(rawMessages)) ||
          (rawStatuses !== undefined && !Array.isArray(rawStatuses))) {
        throw new MetaWebhookPayloadError("Webhook events are malformed.");
      }

      let nestedCount = 0;
      for (const rawMessage of (rawMessages ?? []) as unknown[]) {
        const message = object(rawMessage);
        if (!message || !phoneNumberId) throw new MetaWebhookPayloadError("Inbound message is malformed.");
        const providerMessageId = nonemptyString(message.id);
        const dedupeKey = sha256(providerMessageId
          ? `message:${wabaId}:${phoneNumberId}:${providerMessageId}`
          : `message:${wabaId}:${phoneNumberId}:${canonicalJson(message)}`);
        const classification = classifyInboundOptOut(message, expected.buttonPayloads);
        items.push({
          dedupe_key: dedupeKey,
          kind: "message",
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          field,
          provider_message_id: providerMessageId,
          provider_status: null,
          event_timestamp: metaTimestamp(message.timestamp),
          needs_review: true,
          payload: message,
        });
        if (classification !== "none") {
          optOuts.push({
            waba_id: wabaId,
            phone_number_id: phoneNumberId,
            identity_value: nonemptyString(message.from),
            source_item_key: dedupeKey,
            source_message_id: providerMessageId,
            hold_only: classification === "review",
          });
        }
        nestedCount += 1;
      }

      for (const rawStatus of (rawStatuses ?? []) as unknown[]) {
        const status = object(rawStatus);
        if (!status || !phoneNumberId) throw new MetaWebhookPayloadError("Message status is malformed.");
        const providerMessageId = nonemptyString(status.id);
        const providerStatus = nonemptyString(status.status);
        const eventTimestamp = metaTimestamp(status.timestamp);
        items.push({
          dedupe_key: sha256(`status:${wabaId}:${phoneNumberId}:${canonicalJson(status)}`),
          kind: "status",
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          field,
          provider_message_id: providerMessageId,
          provider_status: providerStatus,
          event_timestamp: eventTimestamp,
          needs_review: !providerMessageId || !providerStatus || !eventTimestamp ||
            !PROJECTED_STATUSES.has(providerStatus),
          payload: status,
        });
        nestedCount += 1;
      }

      if (nestedCount === 0) {
        items.push({
          dedupe_key: sha256(`change:${wabaId}:${phoneNumberId ?? ""}:${field}:${canonicalJson(value)}`),
          kind: "change",
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          field,
          provider_message_id: null,
          provider_status: null,
          event_timestamp: null,
          needs_review: true,
          payload: value,
        });
      }
    }
  }
  if (items.length === 0) throw new MetaWebhookPayloadError("Webhook has no events.");
  return { payload_sha256: sha256(body), payload, items, opt_outs: optOuts };
}
