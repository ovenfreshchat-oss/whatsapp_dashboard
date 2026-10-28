"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getWorkspaceAccess } from "@/server/auth/staff-users/admin";

export type ConsentReviewState = { error: string; success: string };

export async function reviewImportedConsentClaim(
  _previous: ConsentReviewState,
  form: FormData,
): Promise<ConsentReviewState> {
  if (await getWorkspaceAccess() !== "allowed") {
    return { error: "Only a workspace admin can review consent.", success: "" };
  }
  const eventId = form.get("eventId");
  const decision = form.get("decision");
  const source = form.get("source");
  const notice = form.get("noticeText");
  if (typeof eventId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId) ||
      (decision !== "grant" && decision !== "reject") ||
      typeof source !== "string" || !source.trim() || source.trim().length > 200 ||
      typeof notice !== "string" || notice.trim().length > 2000 ||
      (decision === "grant" && !notice.trim())) {
    return { error: "Enter the consent source and, for approval, the exact notice shown.", success: "" };
  }
  const session = await createClient();
  const { data: auth, error: authError } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (authError || !auth.user || !admin) {
    return { error: "The admin session or database is unavailable.", success: "" };
  }
  const { error } = await admin.rpc("review_imported_consent_claim", {
    p_event_id: eventId,
    p_reviewer_user_id: auth.user.id,
    p_source: source.trim(),
    p_notice_text: notice.trim() || null,
    p_decision: decision,
  });
  if (error) {
    return { error: "Could not save this review. Check that the claim is pending and has the required evidence for approval.", success: "" };
  }
  revalidatePath("/dashboard/contacts");
  return { error: "", success: decision === "grant" ? "Consent approved." : "Consent claim rejected." };
}
