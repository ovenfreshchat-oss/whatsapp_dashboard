"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getStaffAdminAccess } from "@/server/auth/staff-users/admin";

export type BatchReviewState = { error: string; success: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reviewImportedConsentBatch(
  _previous: BatchReviewState,
  form: FormData,
): Promise<BatchReviewState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "Only a workspace admin can review consent.", success: "" };
  }
  const batchId = form.get("batchId");
  const key = form.get("idempotencyKey");
  const source = form.get("source");
  const notice = form.get("noticeText");
  if (typeof batchId !== "string" || !UUID.test(batchId) ||
      typeof key !== "string" || !UUID.test(key) ||
      typeof source !== "string" || !source.trim() || source.trim().length > 200 ||
      typeof notice !== "string" || !notice.trim() || notice.trim().length > 2000 ||
      form.get("reviewConfirmed") !== "yes") {
    return { error: "Review the file evidence, then enter its consent source and exact marketing notice.", success: "" };
  }
  const session = await createClient();
  const { data: auth, error: authError } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (authError || !auth.user || !admin) {
    return { error: "The admin session or database is unavailable.", success: "" };
  }
  const { data, error } = await admin.rpc("review_imported_consent_batch", {
    p_batch_id: batchId,
    p_reviewer_user_id: auth.user.id,
    p_source: source.trim(),
    p_notice_text: notice.trim(),
    p_idempotency_key: key,
  });
  if (error || !data || typeof data !== "object") {
    return { error: "Batch review could not be saved. Refresh the import and check the database migration.", success: "" };
  }
  const result = data as { reviewed?: number; skipped?: number };
  revalidatePath(`/dashboard/contacts/imports/${batchId}`);
  revalidatePath("/dashboard/contacts");
  return {
    error: "",
    success: `Approved ${result.reviewed ?? 0} evidenced claims. ${result.skipped ?? 0} incomplete claims remain pending.`,
  };
}
