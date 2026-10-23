import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { getConfiguredMetaIdentifiers, getMetaConfigurationStatus } from "@/server/meta/client";

export type InboxConversation = {
  id: string;
  wa_id: string;
  profile_name: string | null;
  last_inbound_at: string | null;
  last_message_at: string;
  last_message_preview: string | null;
  unread_count: number;
};

export type InboxMessage = {
  id: string;
  direction: "inbound" | "outbound";
  message_type: string;
  body: string | null;
  status: string;
  error_summary: string | null;
  event_at: string;
  /** Present for image, video, audio, sticker and document messages that carry a Meta media id. */
  media?: { kind: MediaKind; filename: string | null } | null;
  /** Customer reaction emoji attached to this message (latest wins). */
  reaction?: string | null;
  /** Set on a stand-alone reaction message whose target is not in this thread. */
  reacted?: { emoji: string | null } | null;
  provider_message_id?: string | null;
  media_id?: string | null;
  media_name?: string | null;
  source_item_key?: string | null;
};

export const MEDIA_KINDS = ["image", "video", "audio", "sticker", "document"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export type InboxSafety = {
  optedOut: boolean;
  senderHold: boolean;
  /** True when a safety lookup failed; replies stay disabled until it succeeds. */
  unavailable: boolean;
};

export type InboxList =
  | { ready: false; reason: "not-configured" | "storage-unavailable" }
  | { ready: true; conversations: InboxConversation[]; total: number };

const CONVERSATION_COLUMNS =
  "id,wa_id,profile_name,last_inbound_at,last_message_at,last_message_preview,unread_count";
const LIST_LIMIT = 100;
const THREAD_LIMIT = 200;

function sender() {
  return getMetaConfigurationStatus().configured ? getConfiguredMetaIdentifiers() : null;
}

export async function listConversations(): Promise<InboxList> {
  const identifiers = sender();
  const admin = createStaffAdminClient();
  if (!identifiers || !admin) return { ready: false, reason: "not-configured" };

  const { data, error, count } = await admin
    .from("inbox_conversations")
    .select(CONVERSATION_COLUMNS, { count: "exact" })
    .eq("waba_id", identifiers.wabaId)
    .eq("phone_number_id", identifiers.phoneNumberId)
    .order("last_message_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) return { ready: false, reason: "storage-unavailable" };
  return { ready: true, conversations: (data ?? []) as InboxConversation[], total: count ?? data?.length ?? 0 };
}

export type InboxThread = {
  conversation: InboxConversation;
  messages: InboxMessage[];
  truncated: boolean;
  safety: InboxSafety;
};

export async function getThread(conversationId: string): Promise<InboxThread | null> {
  const identifiers = sender();
  const admin = createStaffAdminClient();
  if (!identifiers || !admin) return null;

  // Round 1: everything that only needs the conversation id. Round 2: what needs round 1.
  const [convResult, messages, hold] = await Promise.all([
    admin.from("inbox_conversations")
      .select(CONVERSATION_COLUMNS)
      .eq("id", conversationId)
      .eq("waba_id", identifiers.wabaId)
      .eq("phone_number_id", identifiers.phoneNumberId)
      .maybeSingle(),
    admin.from("inbox_messages")
      .select("id,direction,message_type,body,status,error_summary,event_at,source_item_key,provider_message_id,media_id,media_name")
      .eq("conversation_id", conversationId)
      .order("event_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(THREAD_LIMIT + 1),
    admin.from("meta_sender_holds").select("phone_number_id")
      .eq("waba_id", identifiers.wabaId).eq("phone_number_id", identifiers.phoneNumberId)
      .is("released_at", null).limit(1),
  ]);
  const conversation = convResult.data;
  if (convResult.error || !conversation || messages.error) return null;

  const rows0 = (messages.data ?? []) as InboxMessage[];
  const mediaKeys0 = rows0
    .slice(0, THREAD_LIMIT)
    .filter((m) => m.source_item_key && (m.message_type === "reaction" || (MEDIA_KINDS as readonly string[]).includes(m.message_type)))
    .map((m) => m.source_item_key as string);
  const [optOut, itemsResult] = await Promise.all([
    admin.from("meta_opt_outs").select("identity_value")
      .eq("waba_id", identifiers.wabaId).eq("phone_number_id", identifiers.phoneNumberId)
      .eq("identity_value", (conversation as InboxConversation).wa_id).limit(1),
    mediaKeys0.length > 0
      ? admin.from("meta_webhook_items").select("dedupe_key,payload").in("dedupe_key", mediaKeys0)
      : Promise.resolve({ data: [] as { dedupe_key: unknown; payload: unknown }[] }),
  ]);

  const rows = (messages.data ?? []) as InboxMessage[];
  const truncated = rows.length > THREAD_LIMIT;
  const visible = rows.slice(0, THREAD_LIMIT);

  // Media details live in the stored webhook payload; the inbox row keeps only the text.
  if (mediaKeys0.length > 0) {
    const items = itemsResult.data;
    const byKey = new Map((items ?? []).map((i) => [i.dedupe_key as string, i.payload as Record<string, unknown>]));
    for (const m of visible) {
      const payload = m.source_item_key ? byKey.get(m.source_item_key) : undefined;
      if (m.message_type === "reaction") {
        const r = payload?.reaction as { emoji?: unknown; message_id?: unknown } | undefined;
        (m as InboxMessage & { _target?: string | null })._target = typeof r?.message_id === "string" ? r.message_id : null;
        m.reacted = { emoji: typeof r?.emoji === "string" && r.emoji ? r.emoji : null };
        continue;
      }
      const part = payload?.[m.message_type] as { id?: unknown; filename?: unknown } | undefined;
      if (part && typeof part.id === "string" && /^\d{5,30}$/.test(part.id)) {
        m.media = { kind: m.message_type as MediaKind, filename: typeof part.filename === "string" ? part.filename : null };
      }
    }
  }
  // Attach each reaction to the message it targets (visible is newest-first, so walk oldest-first).
  const byProviderId = new Map(visible.filter((m) => m.provider_message_id).map((m) => [m.provider_message_id as string, m]));
  const shown: InboxMessage[] = [];
  for (const m of [...visible].reverse()) {
    const target = (m as InboxMessage & { _target?: string | null })._target;
    const host = target ? byProviderId.get(target) : undefined;
    if (m.message_type === "reaction" && host && host.message_type !== "reaction") {
      host.reaction = m.reacted?.emoji ?? null;
      continue;
    }
    shown.push(m);
  }
  for (const m of shown) {
    if (m.media_id && (MEDIA_KINDS as readonly string[]).includes(m.message_type)) {
      m.media = { kind: m.message_type as MediaKind, filename: m.media_name ?? null };
    }
    delete m.media_id;
    delete m.media_name;
    delete m.source_item_key;
    delete m.provider_message_id;
    delete (m as InboxMessage & { _target?: string | null })._target;
  }
  return {
    conversation: conversation as InboxConversation,
    messages: shown,
    truncated,
    // The reply RPC re-checks all of this under a row lock; this only drives the UI.
    safety: {
      optedOut: Boolean(optOut.data?.length),
      senderHold: Boolean(hold.data?.length),
      unavailable: Boolean(optOut.error || hold.error),
    },
  };
}
