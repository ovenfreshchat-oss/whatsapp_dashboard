import { createStaffAdminClient, getWorkspaceReadAccess } from "@/server/auth/staff-users/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A tiny change token: it moves whenever any message or conversation is added or updated. */
export async function GET(): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (await getWorkspaceReadAccess() !== "allowed") return new Response("Not allowed", { status: 403, headers });
  const admin = createStaffAdminClient();
  if (!admin) return new Response("Unavailable", { status: 503, headers });
  const [messages, conversations] = await Promise.all([
    admin.from("inbox_messages").select("updated_at").order("updated_at", { ascending: false }).limit(1),
    admin.from("inbox_conversations").select("last_message_at").order("last_message_at", { ascending: false }).limit(1),
  ]);
  if (messages.error || conversations.error) return new Response("Unavailable", { status: 503, headers });
  return Response.json({ v: `${messages.data?.[0]?.updated_at ?? ""}|${conversations.data?.[0]?.last_message_at ?? ""}` }, { headers });
}
