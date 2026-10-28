"use server";

import { revalidatePath } from "next/cache";
import { createStaffAdminClient, getWorkspaceAccess } from "@/server/auth/staff-users/admin";
import { isUuid } from "@/server/inbox/format";

/** Clears the unread badge, but only for messages that existed when the staff member opened the thread. */
export async function markConversationRead(conversationId: string, seenThrough: string): Promise<void> {
  if (await getWorkspaceAccess() !== "allowed") return;
  if (!isUuid(conversationId) || Number.isNaN(new Date(seenThrough).valueOf())) return;
  const admin = createStaffAdminClient();
  if (!admin) return;
  await admin.from("inbox_conversations")
    .update({ unread_count: 0 })
    .eq("id", conversationId)
    .lte("last_message_at", seenThrough);
  revalidatePath("/dashboard/inbox");
}
