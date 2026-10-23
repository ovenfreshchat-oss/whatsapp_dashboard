"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getStaffAdminAccess, isStaffAdminEmail } from "@/server/auth/staff-users/admin";
import { getConfiguredMetaIdentifiers } from "@/server/meta/client";

export type HoldReviewState = { error: string; success: string };

export async function releaseAmbiguousSenderHold(
  _previous: HoldReviewState,
  form: FormData,
): Promise<HoldReviewState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "Only a workspace admin can review sender holds.", success: "" };
  }

  const wabaId = form.get("wabaId");
  const phoneNumberId = form.get("phoneNumberId");
  const sourceItemKey = form.get("sourceItemKey");
  const reason = form.get("reviewReason");
  if (typeof wabaId !== "string" || !/^\d{5,32}$/.test(wabaId) ||
      typeof phoneNumberId !== "string" || !/^\d{5,32}$/.test(phoneNumberId) ||
      typeof sourceItemKey !== "string" || !/^[0-9a-f]{64}$/.test(sourceItemKey) ||
      typeof reason !== "string" || reason.trim().length < 10 || reason.trim().length > 1000 ||
      form.get("reviewedEvidence") !== "yes") {
    return { error: "Review the inbound evidence and record a reason of 10–1,000 characters.", success: "" };
  }
  let configured: ReturnType<typeof getConfiguredMetaIdentifiers>;
  try {
    configured = getConfiguredMetaIdentifiers();
  } catch {
    return { error: "Complete the Meta sender configuration before reviewing holds.", success: "" };
  }
  if (wabaId !== configured.wabaId || phoneNumberId !== configured.phoneNumberId) {
    return { error: "This hold does not belong to the configured WhatsApp sender.", success: "" };
  }

  const session = await createClient();
  const { data: auth, error: authError } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (authError || !auth.user?.email_confirmed_at || !isStaffAdminEmail(auth.user.email) || !admin) {
    return { error: "The admin session or database is unavailable.", success: "" };
  }

  const { data, error } = await admin.rpc("release_meta_ambiguous_sender_hold", {
    p_waba_id: wabaId,
    p_phone_number_id: phoneNumberId,
    p_expected_source_item_key: sourceItemKey,
    p_reviewer_user_id: auth.user.id,
    p_review_reason: reason.trim(),
  });
  if (error) {
    return {
      error: "The hold changed, confirmed opt-out evidence exists, or its review record is unavailable. Refresh and review again.",
      success: "",
    };
  }

  revalidatePath("/dashboard/meta/review");
  revalidatePath("/dashboard/meta");
  const released = data !== null && typeof data === "object" &&
    "released_at" in data && typeof data.released_at === "string";
  return {
    error: "",
    success: released
      ? "Message reviewed. Every ambiguous message is now cleared, so the sender hold was released."
      : "Message reviewed. The sender hold remains active until the other ambiguous messages are reviewed.",
  };
}

export async function reconcileConfirmedSenderHold(
  _previous: HoldReviewState,
  form: FormData,
): Promise<HoldReviewState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "Only a workspace admin can reconcile sender holds.", success: "" };
  }

  const wabaId = form.get("wabaId");
  const phoneNumberId = form.get("phoneNumberId");
  const sourceItemKey = form.get("sourceItemKey");
  const recipientE164 = form.get("recipientE164");
  const reason = form.get("reviewReason");
  if (typeof wabaId !== "string" || !/^\d{5,32}$/.test(wabaId) ||
      typeof phoneNumberId !== "string" || !/^\d{5,32}$/.test(phoneNumberId) ||
      typeof sourceItemKey !== "string" || !/^[0-9a-f]{64}$/.test(sourceItemKey) ||
      typeof recipientE164 !== "string" || !/^\+[1-9][0-9]{7,14}$/.test(recipientE164) ||
      typeof reason !== "string" || reason.trim().length < 10 || reason.trim().length > 1000 ||
      form.get("reviewedEvidence") !== "yes" ||
      form.get("confirmedSuppression") !== "yes") {
    return { error: "Review the STOP evidence, enter the matching recipient, and record a reason of 10–1,000 characters.", success: "" };
  }
  let configured: ReturnType<typeof getConfiguredMetaIdentifiers>;
  try {
    configured = getConfiguredMetaIdentifiers();
  } catch {
    return { error: "Complete the Meta sender configuration before reconciling holds.", success: "" };
  }
  if (wabaId !== configured.wabaId || phoneNumberId !== configured.phoneNumberId) {
    return { error: "This hold does not belong to the configured WhatsApp sender.", success: "" };
  }

  const session = await createClient();
  const { data: auth, error: authError } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (authError || !auth.user?.email_confirmed_at || !isStaffAdminEmail(auth.user.email) || !admin) {
    return { error: "The admin session or database is unavailable.", success: "" };
  }

  const { data, error } = await admin.rpc("reconcile_meta_confirmed_sender_hold", {
    p_waba_id: wabaId,
    p_phone_number_id: phoneNumberId,
    p_expected_source_item_key: sourceItemKey,
    p_reviewer_user_id: auth.user.id,
    p_recipient_e164: recipientE164,
    p_review_reason: reason.trim(),
  });
  if (error) {
    return {
      error: "The hold changed, the recipient does not match the provider identity, or its opt-out evidence is unavailable. Refresh and review again.",
      success: "",
    };
  }

  revalidatePath("/dashboard/meta/review");
  revalidatePath("/dashboard/meta");
  const released = data !== null && typeof data === "object" &&
    "released_at" in data && typeof data.released_at === "string";
  return {
    error: "",
    success: released
      ? "STOP reconciled. Its recipient opt-out remains stored, and the sender hold was released."
      : "STOP reconciled. Its recipient opt-out remains stored; the sender stays held until the other messages are reviewed.",
  };
}
