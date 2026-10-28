import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getWorkspaceRole } from "@/server/auth/staff-users/admin";
import { isUuid, replyErrorMessage } from "@/server/inbox/format";
import { getMetaConfigurationStatus, MetaApiError } from "@/server/meta/client";
import {
  MAX_MEDIA_CAPTION_CHARS,
  MAX_TEXT_REPLY_CHARS,
  REPLY_MEDIA_RULES,
  replyMediaKind,
  sendMediaReply,
  sendTextReply,
  uploadReplyMedia,
  type ReplyMediaKind,
} from "@/server/meta/messages";

export const runtime = "nodejs";

type Reply = { error: string; success: string; nextToken: string };

function reply(body: Reply, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Sends a text, photo or video reply. The database enforces the window, opt-out and sender hold. */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  try {
    if (!origin || new URL(origin).origin !== new URL(request.url).origin) {
      return reply({ error: "Request origin is not allowed.", success: "", nextToken: "" }, 403);
    }
  } catch {
    return reply({ error: "Request origin is invalid.", success: "", nextToken: "" }, 403);
  }

  let form: FormData;
  try { form = await request.formData(); } catch {
    return reply({ error: "Could not read the message.", success: "", nextToken: "" }, 400);
  }
  const conversationId = form.get("conversationId");
  const clientToken = form.get("clientToken");
  const keep = (error: string, status = 400): Response =>
    reply({ error, success: "", nextToken: typeof clientToken === "string" ? clientToken : "" }, status);
  const rotated = (error: string, success = ""): Response =>
    reply({ error, success, nextToken: randomUUID() });

  // One Supabase Auth round trip: it both checks admin access and gives the user id.
  const session = await createClient();
  const { data: userData, error: authError } = await session.auth.getUser();
  const staff = userData?.user ?? null;
  if (authError || !staff || !staff.email_confirmed_at || !getWorkspaceRole(staff)) {
    return keep("You don't have permission to reply.", 403);
  }
  if (!getMetaConfigurationStatus().configured) return keep("Complete the Meta server configuration before replying.", 503);
  if (!isUuid(conversationId) || !isUuid(clientToken)) return rotated("The reply form was invalid. Refresh and try again.");

  const rawBody = form.get("body");
  const text = (typeof rawBody === "string" ? rawBody : "").replace(/\r\n/g, "\n").trim();
  const file = form.get("file");
  const hasFile = file instanceof File && file.size > 0;
  let kind: ReplyMediaKind | null = null;
  if (hasFile) {
    kind = replyMediaKind(file.type);
    if (!kind) return keep("Send a JPG or PNG photo, or an MP4 video.");
    if (file.size > REPLY_MEDIA_RULES[kind].maxBytes) return keep(REPLY_MEDIA_RULES[kind].label);
    if (text.length > MAX_MEDIA_CAPTION_CHARS) return keep(`A caption can be at most ${MAX_MEDIA_CAPTION_CHARS} characters.`);
  } else if (!text || text.length > MAX_TEXT_REPLY_CHARS) {
    return keep(replyErrorMessage("invalid_reply"));
  }

  const admin = createStaffAdminClient();
  if (!admin) return keep("Your admin session or server database connection is unavailable.", 503);

  // Upload first (nothing reaches the customer yet), then reserve under the database checks.
  let mediaId: string | null = null;
  if (hasFile && kind) {
    try {
      mediaId = await uploadReplyMedia({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, name: file.name });
    } catch (error) {
      return keep(error instanceof MetaApiError ? error.message : "The file could not be uploaded.", 502);
    }
  }

  const { data: reserved, error: reserveError } = await admin.rpc("begin_inbox_reply", {
    p_conversation_id: conversationId,
    p_body: text,
    p_client_token: clientToken,
    p_actor_user_id: staff.id,
    p_message_type: kind ?? "text",
    p_media_id: mediaId,
    p_media_mime: hasFile ? file.type : null,
    p_media_name: hasFile ? file.name.slice(0, 200) : null,
  });
  if (reserveError) {
    const known = ["window_closed", "opted_out", "sender_hold", "invalid_reply", "invalid_recipient", "conversation_missing"]
      .find((code) => reserveError.message.includes(code));
    if (!known) return keep("Inbox storage is unavailable. Apply drizzle/0009_inbox_media_send.sql, then try again. Nothing was sent.", 503);
    revalidatePath("/dashboard/inbox");
    return rotated(replyErrorMessage(known));
  }
  const reservation = reserved as { id?: string; created?: boolean; wa_id?: string } | null;
  if (!reservation?.id || typeof reservation.wa_id !== "string") return rotated("The reply could not be reserved. Nothing was sent.");
  if (reservation.created !== true) {
    revalidatePath("/dashboard/inbox");
    return rotated("", "This reply was already submitted. Its status is shown in the thread.");
  }

  try {
    const accepted = kind && mediaId
      ? await sendMediaReply({ toWaId: reservation.wa_id, kind, mediaId, caption: text })
      : await sendTextReply({ toWaId: reservation.wa_id, body: text });
    const { error: recordError } = await admin.rpc("record_inbox_reply_result", {
      p_id: reservation.id, p_state: "accepted", p_wamid: accepted.messageId, p_error_summary: null,
    });
    revalidatePath("/dashboard/inbox");
    if (recordError) return rotated(`Meta accepted the message (${accepted.messageId}) but its status could not be saved. Do not resend; check the thread.`);
    return rotated("", "Sent to WhatsApp. Delivery ticks update as Meta reports them.");
  } catch (error) {
    const knownRejection = error instanceof MetaApiError && error.definitiveRejection;
    const summary = error instanceof MetaApiError
      ? `${error.category} (${error.httpStatus ?? "no HTTP status"}${error.providerCode ? `, code ${error.providerCode}` : ""})`
      : "unknown failure";
    const { error: recordError } = await admin.rpc("record_inbox_reply_result", {
      p_id: reservation.id, p_state: knownRejection ? "rejected" : "uncertain", p_wamid: null, p_error_summary: summary,
    });
    revalidatePath("/dashboard/inbox");
    if (recordError) return rotated("The outcome could not be saved. Check the customer's thread before resending.");
    return rotated(knownRejection
      ? error instanceof MetaApiError ? error.message : "Meta rejected the reply."
      : "The outcome is uncertain: Meta may or may not have received it. Check the thread before resending.");
  }
}
