import { createStaffAdminClient, getWorkspaceAccess } from "@/server/auth/staff-users/admin";
import { MEDIA_KINDS } from "@/server/inbox/store";
import { getConfiguredMetaIdentifiers, getMetaConfigurationStatus } from "@/server/meta/client";
import { fetchMetaMedia } from "@/server/meta/media";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ messageId: string }> }): Promise<Response> {
  if (await getWorkspaceAccess() !== "allowed") return fail(403, "Not allowed");
  const { messageId } = await params;
  if (!UUID.test(messageId)) return fail(404, "Not found");
  const admin = createStaffAdminClient();
  if (!admin || !getMetaConfigurationStatus().configured) return fail(503, "Unavailable");
  const { wabaId, phoneNumberId } = getConfiguredMetaIdentifiers();

  const { data: message } = await admin.from("inbox_messages")
    .select("message_type,source_item_key,media_id,inbox_conversations!inner(waba_id,phone_number_id)")
    .eq("id", messageId).maybeSingle();
  const conversation = (message as { inbox_conversations?: { waba_id: string; phone_number_id: string } } | null)?.inbox_conversations;
  if (!message || !(message.source_item_key || message.media_id) || !conversation ||
      conversation.waba_id !== wabaId || conversation.phone_number_id !== phoneNumberId ||
      !(MEDIA_KINDS as readonly string[]).includes(message.message_type)) {
    return fail(404, "Not found");
  }
  let mediaId: string | null = typeof message.media_id === "string" ? message.media_id : null;
  if (!mediaId) {
    const { data: item } = await admin.from("meta_webhook_items")
      .select("payload").eq("dedupe_key", message.source_item_key).maybeSingle();
    const part = (item?.payload as Record<string, { id?: unknown }> | undefined)?.[message.message_type];
    if (part && typeof part.id === "string") mediaId = part.id;
  }
  if (!mediaId) return fail(404, "Not found");

  let media;
  try { media = await fetchMetaMedia(mediaId); } catch { return fail(502, "Meta could not return this file"); }
  if (!media) return fail(404, "File unavailable or expired");

  return new Response(media.response.body, {
    headers: {
      "Content-Type": media.contentType,
      "Content-Disposition": media.inline ? "inline" : "attachment",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=300",
    },
  });
}
