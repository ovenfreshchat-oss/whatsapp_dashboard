"use server";

import { revalidatePath } from "next/cache";
import { createStaffAdminClient, getWorkspaceAccess } from "@/server/auth/staff-users/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ActiveResult = { error: string; changed: number };

async function admin() {
  if (await getWorkspaceAccess() !== "allowed") return null;
  return createStaffAdminClient();
}

/** Switch one number on or off for campaigns. */
export async function setContactActiveAction(contactId: string, active: boolean): Promise<ActiveResult> {
  if (!UUID.test(contactId) || typeof active !== "boolean") return { error: "Invalid request.", changed: 0 };
  const client = await admin();
  if (!client) return { error: "Only a workspace admin can change this.", changed: 0 };
  const { error } = await client.rpc("set_contact_campaign_active", { p_contact_id: contactId, p_active: active });
  if (error) return { error: "Could not save. Apply drizzle/0020_contact_campaign_active.sql and try again.", changed: 0 };
  revalidatePath("/dashboard/contacts", "layout");
  return { error: "", changed: 1 };
}

/** Switch every number from one upload on or off. */
export async function setBatchActiveAction(batchId: string, active: boolean): Promise<ActiveResult> {
  if (!UUID.test(batchId) || typeof active !== "boolean") return { error: "Invalid request.", changed: 0 };
  const client = await admin();
  if (!client) return { error: "Only a workspace admin can change this.", changed: 0 };
  const { data, error } = await client.rpc("set_batch_campaign_active", { p_batch_id: batchId, p_active: active });
  if (error) return { error: "Could not save. Apply drizzle/0020_contact_campaign_active.sql and try again.", changed: 0 };
  revalidatePath("/dashboard/contacts", "layout");
  return { error: "", changed: typeof data === "number" ? data : 0 };
}
