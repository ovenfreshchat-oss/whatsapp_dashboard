import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { previewContactImport } from "@/server/imports";
import { authorizeImportRequest, ImportRequestError, importJson, readImportForm } from "../shared";
import { importErrorResponse, importMapping, parsedImportFile } from "../input";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<Response> {
  try {
    await authorizeImportRequest(request);
    const form = await readImportForm(request);
    const importKey = form.get("importKey");
    const expectedHash = form.get("expectedFileSha256");
    if (typeof importKey !== "string" || !UUID.test(importKey) ||
        typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedHash)) {
      throw new ImportRequestError("Preview the file again before importing.", 400);
    }
    const mapping = importMapping(form);
    if (!mapping) throw new ImportRequestError("Map the phone number column before importing.", 400);
    const parsed = await parsedImportFile(form);
    if (parsed.fileSha256 !== expectedHash) {
      throw new ImportRequestError("The file changed after preview. Preview it again.", 409);
    }
    const preview = previewContactImport(parsed, mapping);
    if (preview.validRows.length === 0) {
      throw new ImportRequestError("No valid contact rows can be imported.", 400);
    }
    const session = await createClient();
    const { data: auth, error: authError } = await session.auth.getUser();
    const admin = createStaffAdminClient();
    if (authError || !auth.user || !admin) {
      throw new ImportRequestError("The admin session or database is unavailable.", 503);
    }
    const { data, error } = await admin.rpc("import_contact_batch", {
      p_import_key: importKey,
      p_actor_user_id: auth.user.id,
      p_file_name: parsed.fileName,
      p_file_kind: parsed.fileKind,
      p_file_sha256: parsed.fileSha256,
      p_rows: preview.validRows,
      p_errors: preview.errors,
    });
    if (error) {
      // Database messages can contain uploaded row values. Keep diagnostics to
      // the SQLSTATE and show a specific repair only for the known pgcrypto path fault.
      console.error("Contact import RPC failed", { code: error.code });
      if (error.code === "42883" && /^function digest\(/i.test(error.message)) {
        return importJson({
          error: "The database import function needs the contact import repair migration (drizzle/0004_contact_import_pgcrypto_path.sql). Apply it in Supabase, then retry.",
          code: error.code,
        }, 503);
      }
      if (error.code === "PGRST202") {
        return importJson({ error: "The contact import function is missing. Apply the contacts database migration, then retry.", code: error.code }, 503);
      }
      const code = /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unknown";
      return importJson({ error: `The contact import could not be saved (database code ${code}). Contact the database administrator.`, code }, 503);
    }
    // Link the imported numbers to this batch so a campaign can target "Selected import".
    // The import is already committed, so a failure here is reported without undoing it.
    let linked: number | null = null;
    let linkError: string | null = null;
    const batchId = (data as { batch_id?: unknown } | null)?.batch_id;
    if (typeof batchId === "string" && UUID.test(batchId)) {
      const { data: count, error: batchError } = await admin.rpc("link_import_batch_contacts", {
        p_batch_id: batchId,
        p_actor_user_id: auth.user.id,
        p_phones: preview.validRows.map((row) => row.phone_e164),
      });
      if (batchError) {
        console.error("Linking import batch failed", { code: batchError.code });
        linkError = batchError.code === "PGRST202"
          ? "The contacts were imported, but drizzle/0008_send_to_any_saved_number.sql is not applied yet. Apply it, then use \"All contacts\" for campaigns."
          : "The contacts were imported, but could not be linked to this import for campaigns. Use \"All contacts\".";
      } else {
        linked = typeof count === "number" ? count : null;
      }
    }
    revalidatePath("/dashboard/contacts");
    return importJson({ result: data, stats: preview.stats, linked, linkError });
  } catch (error) {
    return importErrorResponse(error);
  }
}
