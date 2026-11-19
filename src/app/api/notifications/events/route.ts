import { createStaffAdminClient, getWorkspaceReadAccess } from "@/server/auth/staff-users/admin";
import { getConfiguredMetaIdentifiers, getMetaConfigurationStatus } from "@/server/meta/client";
import type { NotificationEvent, NotificationFeedResponse } from "@/components/notifications/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PER_SOURCE_LIMIT = 20;

function preview(body: string | null, messageType: string): string {
  if (body && body.trim()) return body.trim().slice(0, 140);
  return messageType && messageType !== "text" ? `Sent a ${messageType}` : "New message";
}

/**
 * Delta feed of notification-worthy events since `since` (ISO timestamp), for the bell dropdown.
 * No notification state is stored here: the client keeps read/cleared state in LocalStorage and
 * this route only ever reports facts already in inbox/campaign tables, deduplicated by their own
 * stable ids (never synthesized), so a repeated poll cannot create a new "new message" event.
 */
export async function GET(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (await getWorkspaceReadAccess() !== "allowed") return new Response("Not allowed", { status: 403, headers });

  const now = new Date();
  const nowIso = now.toISOString();
  const sinceParam = new URL(request.url).searchParams.get("since");
  const requested = sinceParam ? new Date(sinceParam) : null;
  // First-ever call for this reader: establish a baseline, do not flood with history.
  if (!requested || Number.isNaN(requested.getTime())) {
    return Response.json({ now: nowIso, events: [] } satisfies NotificationFeedResponse, { headers });
  }
  const floor = now.getTime() - MAX_WINDOW_MS;
  const since = new Date(Math.max(requested.getTime(), floor));
  const sinceIso = since.toISOString();
  if (since.getTime() >= now.getTime()) {
    return Response.json({ now: nowIso, events: [] } satisfies NotificationFeedResponse, { headers });
  }

  const admin = createStaffAdminClient();
  if (!admin || !getMetaConfigurationStatus().configured) {
    return Response.json({ now: nowIso, events: [] } satisfies NotificationFeedResponse, { headers });
  }
  const { wabaId, phoneNumberId } = getConfiguredMetaIdentifiers();
  const events: NotificationEvent[] = [];

  try {
    const [conversations, campaigns, alerts] = await Promise.all([
      admin.from("inbox_conversations")
        .select("id,wa_id,profile_name,created_at")
        .eq("waba_id", wabaId).eq("phone_number_id", phoneNumberId),
      admin.from("whatsapp_campaigns")
        .select("id,name,completed_at")
        .eq("waba_id", wabaId).eq("phone_number_id", phoneNumberId)
        .eq("state", "completed")
        .gt("completed_at", sinceIso).lte("completed_at", nowIso)
        .order("completed_at", { ascending: true }).limit(PER_SOURCE_LIMIT),
      admin.from("sender_alerts")
        .select("id,code,title,first_seen_at")
        .eq("waba_id", wabaId).eq("phone_number_id", phoneNumberId)
        .is("resolved_at", null)
        .gt("first_seen_at", sinceIso).lte("first_seen_at", nowIso)
        .order("first_seen_at", { ascending: true }).limit(PER_SOURCE_LIMIT),
    ]);

    const convRows = conversations.data ?? [];
    const byConversation = new Map(convRows.map((row) => [row.id as string, row]));
    const convIds = convRows.map((row) => row.id as string);

    const messages = convIds.length
      ? await admin.from("inbox_messages")
          .select("id,conversation_id,body,message_type,event_at")
          .in("conversation_id", convIds)
          .eq("direction", "inbound")
          .gt("event_at", sinceIso).lte("event_at", nowIso)
          .order("event_at", { ascending: true }).limit(PER_SOURCE_LIMIT)
      : { data: [], error: null };

    for (const row of convRows) {
      const createdAt = row.created_at as string;
      if (new Date(createdAt).getTime() <= since.getTime()) continue;
      events.push({
        id: `conv:${row.id}`,
        kind: "conversation",
        title: "New conversation",
        body: (row.profile_name as string | null) || (row.wa_id as string),
        href: `/dashboard/inbox?c=${row.id}`,
        occurredAt: createdAt,
      });
    }

    for (const row of (messages.data ?? [])) {
      const conversation = byConversation.get(row.conversation_id as string);
      events.push({
        id: `msg:${row.id}`,
        kind: "message",
        title: (conversation?.profile_name as string | null) || (conversation?.wa_id as string | undefined) || "New message",
        body: preview(row.body as string | null, row.message_type as string),
        href: `/dashboard/inbox?c=${row.conversation_id}`,
        occurredAt: row.event_at as string,
      });
    }

    for (const row of (campaigns.data ?? [])) {
      events.push({
        id: `campaign:${row.id}:completed`,
        kind: "campaign_completed",
        title: "Campaign completed",
        body: row.name as string,
        href: `/dashboard/campaigns/${row.id}/analytics`,
        occurredAt: row.completed_at as string,
      });
    }

    for (const row of (alerts.data ?? [])) {
      events.push({
        id: `alert:${row.id}`,
        kind: "campaign_failed",
        title: "Campaign sending paused",
        body: (row.title as string | null) || `Meta restricted your number (code ${row.code})`,
        href: "/dashboard/campaigns",
        occurredAt: row.first_seen_at as string,
      });
    }
  } catch {
    return Response.json({ now: nowIso, events: [] } satisfies NotificationFeedResponse, { headers });
  }

  events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  return Response.json({ now: nowIso, events } satisfies NotificationFeedResponse, { headers });
}
