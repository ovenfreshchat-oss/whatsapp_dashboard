import { createStaffAdminClient } from "@/server/auth/staff-users/admin";

export type DuplicateList = { id: string; fileName: string; createdAt: string; contacts: number };
export type DuplicateMode = "merge" | "replace";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The newest active list with the same file name (case-insensitive), or null. Never throws. */
export async function findDuplicateList(fileName: string): Promise<DuplicateList | null> {
  const admin = createStaffAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.from("contact_import_batches")
    .select("id,file_name,created_at,accepted_rows")
    .is("archived_at", null).ilike("file_name", fileName.trim().replace(/[%_\\]/g, "\\$&"))
    .order("created_at", { ascending: false }).limit(1);
  const row = error ? null : data?.[0];
  if (!row) return null;
  return { id: String(row.id), fileName: String(row.file_name), createdAt: String(row.created_at), contacts: Number(row.accepted_rows) || 0 };
}

export function parseDuplicateChoice(form: FormData): { mode: DuplicateMode; oldBatchId: string } | null {
  const mode = form.get("duplicateMode");
  const id = form.get("duplicateBatchId");
  if (mode === null && id === null) return null;
  if ((mode !== "merge" && mode !== "replace") || typeof id !== "string" || !UUID.test(id)) return null;
  return { mode, oldBatchId: id };
}

/** Runs after the new import has been saved. Returns an error message, or null when it worked. */
export async function applyDuplicateChoice(
  choice: { mode: DuplicateMode; oldBatchId: string }, newBatchId: string, fileName: string,
): Promise<string | null> {
  const admin = createStaffAdminClient();
  if (!admin) return "The database is unavailable.";
  // Trust the server, not the browser: the old list must still exist, be active and carry this file name.
  const old = await admin.from("contact_import_batches").select("file_name,archived_at").eq("id", choice.oldBatchId).maybeSingle();
  if (old.error || !old.data || old.data.archived_at !== null ||
      String(old.data.file_name).trim().toLowerCase() !== fileName.trim().toLowerCase()) {
    return "The earlier list changed or was already removed.";
  }
  const { error } = await admin.rpc("resolve_duplicate_import_list", {
    p_old_batch_id: choice.oldBatchId, p_new_batch_id: newBatchId, p_mode: choice.mode,
  });
  if (error) {
    console.error("Duplicate list resolution failed", { code: error.code });
    return error.code === "PGRST202" ? "Apply drizzle/0031_import_list_archive.sql in Supabase, then try again." : "The earlier list could not be updated.";
  }
  return null;
}
