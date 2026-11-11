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

/** Delete an upload: the list disappears, its contacts and campaign history stay. */
export async function deleteBatchAction(batchId: string): Promise<{ error: string }> {
  if (!UUID.test(batchId)) return { error: "Invalid request." };
  const client = await admin();
  if (!client) return { error: "Only a workspace admin can change this." };
  const { data, error } = await client.rpc("archive_import_batch", { p_batch_id: batchId });
  if (error) return { error: "Could not delete. Apply drizzle/0031 and 0033 in Supabase, then try again." };
  if (data === "in_use") return { error: "A campaign using this upload is scheduled, running or paused. Finish or cancel it first." };
  if (data !== "ok") return { error: "This upload was already deleted." };
  revalidatePath("/dashboard/contacts", "layout");
  revalidatePath("/dashboard/campaigns", "layout");
  return { error: "" };
}

/** Take one number out of this upload. The contact itself is kept. */
export async function removeNumberFromBatchAction(batchId: string, contactId: string): Promise<{ error: string }> {
  if (!UUID.test(batchId) || !UUID.test(contactId)) return { error: "Invalid request." };
  const client = await admin();
  if (!client) return { error: "Only a workspace admin can change this." };
  const { error } = await client.rpc("remove_contact_from_batch", { p_batch_id: batchId, p_contact_id: contactId });
  if (error) return { error: "Could not remove. Apply drizzle/0033_delete_upload_and_numbers.sql and try again." };
  revalidatePath("/dashboard/contacts", "layout");
  return { error: "" };
}
