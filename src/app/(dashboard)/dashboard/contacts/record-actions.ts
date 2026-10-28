"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getWorkspaceAccess } from "@/server/auth/staff-users/admin";

export type RecordConsentState = { error: string; success: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export async function recordContactConsent(
  _previous: RecordConsentState,
  form: FormData,
): Promise<RecordConsentState> {
  if (await getWorkspaceAccess() !== "allowed") {
    return { error: "Only a workspace admin can record consent.", success: "" };
  }
  const id = form.get("contactId");
  const key = form.get("idempotencyKey");
  const decision = form.get("decision");
  const source = form.get("source");
  const notice = form.get("noticeText");
  const evidence = form.get("evidenceReference");
  const occurred = form.get("occurredAt");
  const grant = decision === "grant";
  if (typeof id !== "string" || !UUID.test(id) ||
      typeof key !== "string" || !UUID.test(key) ||
      (decision !== "grant" && decision !== "revoke") ||
      typeof source !== "string" || !source.trim() || source.trim().length > 200 ||
      typeof notice !== "string" || notice.trim().length > 2000 ||
      typeof evidence !== "string" || evidence.trim().length > 500 ||
      typeof occurred !== "string" || !ZONED_TIME.test(occurred.trim()) ||
      !Number.isFinite(Date.parse(occurred)) || Date.parse(occurred) > Date.now() + 300_000 ||
      (grant && (!notice.trim() || !evidence.trim()))) {
    return { error: "Enter the source and a time with timezone. Approval also needs the exact notice and a per-person evidence reference.", success: "" };
  }
  const session = await createClient();
  const { data: auth, error: authError } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (authError || !auth.user || !admin) {
    return { error: "The admin session or database is unavailable.", success: "" };
  }
  const { error } = await admin.rpc("record_contact_consent", {
    p_idempotency_key: key,
    p_contact_id: id,
    p_decision: decision,
    p_source: source.trim(),
    p_notice_text: notice.trim() || null,
    p_evidence_reference: evidence.trim() || null,
    p_occurred_at: occurred.trim(),
    p_reviewer_user_id: auth.user.id,
  });
  if (error) {
    return { error: "The consent record could not be saved. Check the evidence, timestamp, and database migration.", success: "" };
  }
  revalidatePath(`/dashboard/contacts/${id}`);
  revalidatePath("/dashboard/contacts");
  return { error: "", success: grant ? "Verified consent recorded." : "Opt-out recorded. This contact is suppressed from marketing sends." };
}
