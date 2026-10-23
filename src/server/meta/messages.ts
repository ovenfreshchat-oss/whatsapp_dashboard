import { getConfiguredMetaIdentifiers, MetaApiError, metaGraphPost } from "./client";

export const MAX_TEXT_REPLY_CHARS = 4096;

export type MetaAcceptedTextReply = {
  messageId: string;
  acceptedAt: string;
};

function rejectReply(message: string): never {
  throw new MetaApiError(message, "validation", { definitiveRejection: true });
}

/**
 * Sends one free-text message inside WhatsApp's 24-hour customer service window.
 * The window, opt-out, and sender-hold rules are enforced by `begin_inbox_reply`
 * before this runs. An HTTP success only means Meta accepted the message for
 * processing; delivery arrives later as a webhook status.
 */
export async function sendTextReply(input: {
  /** Customer WhatsApp ID: digits only, with country code and no "+". */
  toWaId: string;
  body: string;
}): Promise<MetaAcceptedTextReply> {
  if (!/^[1-9]\d{7,14}$/.test(input.toWaId)) rejectReply("The customer's WhatsApp ID is not a valid phone number.");
  const body = input.body.trim();
  if (!body || body.length > MAX_TEXT_REPLY_CHARS) {
    rejectReply(`A reply must be between 1 and ${MAX_TEXT_REPLY_CHARS} characters.`);
  }

  const { phoneNumberId } = getConfiguredMetaIdentifiers();
  const response = await metaGraphPost(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.toWaId,
    type: "text",
    text: { preview_url: false, body },
  });

  const messages = response.messages;
  const first = Array.isArray(messages) ? messages[0] : null;
  const id = first !== null && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>).id : null;
  if (typeof id !== "string" || !id.startsWith("wamid.")) {
    throw new MetaApiError("Meta accepted the request without a usable message ID; reconcile before retrying.", "response");
  }
  return { messageId: id, acceptedAt: new Date().toISOString() };
}

export const REPLY_MEDIA_RULES = {
  image: { types: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024, label: "A photo must be a JPG or PNG under 5 MB." },
  video: { types: ["video/mp4", "video/3gpp"], maxBytes: 16 * 1024 * 1024, label: "A video must be an MP4 under 16 MB." },
} as const;
export type ReplyMediaKind = keyof typeof REPLY_MEDIA_RULES;
export const MAX_MEDIA_CAPTION_CHARS = 1024;

export function replyMediaKind(mime: string): ReplyMediaKind | null {
  for (const kind of Object.keys(REPLY_MEDIA_RULES) as ReplyMediaKind[]) {
    if ((REPLY_MEDIA_RULES[kind].types as readonly string[]).includes(mime)) return kind;
  }
  return null;
}

/** Uploads a file to WhatsApp and returns its media ID. Nothing is sent to the customer yet. */
export async function uploadReplyMedia(input: { bytes: Uint8Array; mime: string; name: string }): Promise<string> {
  const kind = replyMediaKind(input.mime);
  if (!kind) rejectReply("Send a JPG or PNG photo, or an MP4 video.");
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > REPLY_MEDIA_RULES[kind].maxBytes) {
    rejectReply(REPLY_MEDIA_RULES[kind].label);
  }
  const token = process.env.META_SYSTEM_USER_ACCESS_TOKEN?.trim();
  const version = process.env.META_GRAPH_API_VERSION?.trim();
  const { phoneNumberId } = getConfiguredMetaIdentifiers();
  if (!token || !version) rejectReply("Meta is not configured.");

  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", input.mime);
  form.set("file", new Blob([Buffer.from(input.bytes)], { type: input.mime }), input.name.slice(0, 100) || "file");
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    // Nothing has been sent to the customer at this point, so a retry is safe.
    rejectReply("The file could not be uploaded to WhatsApp. Try again.");
  }
  if (!response.ok) rejectReply("WhatsApp rejected the file. Check its type and size.");
  const id = ((await response.json().catch(() => null)) as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !/^\d{5,32}$/.test(id)) rejectReply("WhatsApp did not accept the file.");
  return id;
}

/** Sends an uploaded photo or video inside the 24-hour window. Same rules as a text reply. */
export async function sendMediaReply(input: {
  toWaId: string;
  kind: ReplyMediaKind;
  mediaId: string;
  caption: string;
}): Promise<MetaAcceptedTextReply> {
  if (!/^[1-9]\d{7,14}$/.test(input.toWaId)) rejectReply("The customer's WhatsApp ID is not a valid phone number.");
  if (!/^\d{5,32}$/.test(input.mediaId)) rejectReply("The media ID is invalid.");
  const caption = input.caption.trim();
  if (caption.length > MAX_MEDIA_CAPTION_CHARS) rejectReply(`A caption can be at most ${MAX_MEDIA_CAPTION_CHARS} characters.`);

  const { phoneNumberId } = getConfiguredMetaIdentifiers();
  const response = await metaGraphPost(`${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.toWaId,
    type: input.kind,
    [input.kind]: { id: input.mediaId, ...(caption ? { caption } : {}) },
  });
  const first = Array.isArray(response.messages) ? response.messages[0] : null;
  const id = first !== null && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>).id : null;
  if (typeof id !== "string" || !id.startsWith("wamid.")) {
    throw new MetaApiError("Meta accepted the request without a usable message ID; reconcile before retrying.", "response");
  }
  return { messageId: id, acceptedAt: new Date().toISOString() };
}
