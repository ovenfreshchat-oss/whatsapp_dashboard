import { createStaffAdminClient } from "@/server/auth/staff-users/admin";

export type DuplicateList = { id: string; fileName: string; createdAt: string; contacts: number };

export const DUPLICATE_LIST_MESSAGE =
  "A list with the same name already exists. Please rename the file to upload or delete the existing list with the same name.";

/** The newest active list with the same file name (case-insensitive), or null. Never throws. */
/** `exceptImportKey` ignores the list created by this same import, so a retried request is not blocked by itself. */
export async function findDuplicateList(fileName: string, exceptImportKey?: string): Promise<DuplicateList | null> {
  const admin = createStaffAdminClient();
  if (!admin) return null;
  let query = admin.from("contact_import_batches")
    .select("id,file_name,created_at,accepted_rows")
    .is("archived_at", null).ilike("file_name", fileName.trim().replace(/[%_\\]/g, "\\$&"));
  if (exceptImportKey) query = query.neq("import_key", exceptImportKey);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(1);
  const row = error ? null : data?.[0];
  if (!row) return null;
  return { id: String(row.id), fileName: String(row.file_name), createdAt: String(row.created_at), contacts: Number(row.accepted_rows) || 0 };
}
