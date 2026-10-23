"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getStaffAdminAccess } from "@/server/auth/staff-users/admin";
import {
  getConfiguredMetaIdentifiers,
  getMetaConfigurationStatus,
  listMetaWebhookSubscriptions,
  MetaApiError,
} from "@/server/meta/client";
import { sendApprovedTemplateTest } from "@/server/meta/templates";

export type TestSendState = {
  error: string;
  success: string;
  messageId: string;
};

const emptyState: TestSendState = { error: "", success: "", messageId: "" };

async function assertWebhookReady(admin: NonNullable<ReturnType<typeof createStaffAdminClient>>) {
  if (!process.env.META_APP_SECRET?.trim() ||
      !process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() ||
      !process.env.META_APP_ID?.trim()) {
    throw new MetaApiError("Complete webhook signing, verification, and app ID setup before sending.", "validation", { definitiveRejection: true });
  }
  const [subscription, inbox] = await Promise.all([
    listMetaWebhookSubscriptions(),
    admin.from("meta_webhook_envelopes").select("received_at").limit(1),
  ]);
  if (!subscription.isCurrentAppSubscribed || inbox.error) {
    throw new MetaApiError("The app webhook subscription or inbox could not be verified. No message was sent.", "validation", { definitiveRejection: true });
  }
}

async function assertTestRecipientAllowed(
  admin: NonNullable<ReturnType<typeof createStaffAdminClient>>,
  wabaId: string,
  phoneNumberId: string,
  recipientE164: string,
) {
  const [holds, optOuts] = await Promise.all([
    admin.from("meta_sender_holds").select("phone_number_id")
      .eq("waba_id", wabaId).eq("phone_number_id", phoneNumberId)
      .is("released_at", null).limit(1),
    admin.from("meta_opt_outs").select("identity_value")
      .eq("waba_id", wabaId).eq("phone_number_id", phoneNumberId)
      .eq("identity_value", recipientE164.slice(1)).limit(1),
  ]);
  if (holds.error || optOuts.error) {
    throw new MetaApiError("Opt-out safety checks are unavailable; no test message was sent.", "validation", { definitiveRejection: true });
  }
  if (holds.data?.length || optOuts.data?.length) {
    throw new MetaApiError("Sending is on hold after an opt-out. Reconcile the request before testing again.", "validation", { definitiveRejection: true });
  }
}

export async function sendMetaTestMessage(
  _previousState: TestSendState,
  formData: FormData,
): Promise<TestSendState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { ...emptyState, error: "Only a workspace admin can send a Meta test message." };
  }

  const configured = getMetaConfigurationStatus();
  if (!configured.configured) {
    return { ...emptyState, error: "Complete the Meta server configuration before testing." };
  }

  const allowedRecipient = process.env.META_TEST_RECIPIENT_E164?.trim();
  const recipient = formData.get("recipientE164");
  const templateKey = formData.get("templateKey");
  const rawParameters = formData.get("bodyParameters");

  if (
    !allowedRecipient ||
    !/^\+[1-9]\d{7,14}$/.test(allowedRecipient) ||
    recipient !== allowedRecipient ||
    formData.get("testConsent") !== "yes" ||
    typeof templateKey !== "string" ||
    typeof rawParameters !== "string"
  ) {
    return { ...emptyState, error: "Choose an approved template and confirm your configured test recipient has agreed to receive it." };
  }

  const [templateName, languageCode, extra] = templateKey.split("|");
  if (!templateName || !languageCode || extra !== undefined) {
    return { ...emptyState, error: "Choose a valid approved template." };
  }

  const bodyParameters = rawParameters.trim()
    ? rawParameters.replace(/\r/g, "").split("\n").map((value) => value.trim()).filter((value) => value.length > 0)
    : [];
  if (bodyParameters.length > 20 || bodyParameters.some((value) => !value || value.length > 1024)) {
    return { ...emptyState, error: "Enter one nonempty template value per line, with at most 20 values." };
  }

  const rawHeaderMediaUrl = formData.get("headerMediaUrl");
  const headerMediaUrl = typeof rawHeaderMediaUrl === "string" && rawHeaderMediaUrl.trim()
    ? rawHeaderMediaUrl.trim() : undefined;

  const session = await createClient();
  const { data: userData, error: authError } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (authError || !userData.user || !admin) {
    return { ...emptyState, error: "Your admin session or server database connection is unavailable." };
  }

  const { wabaId, phoneNumberId } = getConfiguredMetaIdentifiers();
  try {
    await assertWebhookReady(admin);
    await assertTestRecipientAllowed(admin, wabaId, phoneNumberId, recipient);
  } catch (error) {
    return { ...emptyState, error: error instanceof MetaApiError ? error.message : "Webhook or opt-out safety checks failed." };
  }
  const { data: attempt, error: insertError } = await admin
    .from("meta_test_sends")
    .insert({
      actor_user_id: userData.user.id,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      recipient_e164: recipient,
      template_name: templateName,
      template_language: languageCode,
      state: "prepared",
    })
    .select("id")
    .single();

  if (insertError || !attempt) {
    if (insertError?.code === "23505") {
      return { ...emptyState, error: "A previous test to this number is still active or awaiting delivery. Review its outcome before sending again." };
    }
    return { ...emptyState, error: "Test-send history is unavailable. Apply the Meta database migration before sending." };
  }

  const { data: started, error: startError } = await admin
    .from("meta_test_sends")
    .update({ state: "in_flight", started_at: new Date().toISOString() })
    .eq("id", attempt.id)
    .eq("state", "prepared")
    .select("id")
    .single();

  if (startError || !started) {
    return { ...emptyState, error: "The test attempt could not be recorded. No message was sent." };
  }

  try {
    const accepted = await sendApprovedTemplateTest({
      recipientE164: recipient,
      templateName,
      languageCode,
      bodyParameters,
      headerMediaUrl,
      beforeSend: async () => {
        await assertWebhookReady(admin);
        await assertTestRecipientAllowed(admin, wabaId, phoneNumberId, recipient);
      },
    });
    const { error: updateError } = await admin.rpc("record_meta_test_send_result", {
      p_id: attempt.id,
      p_state: "accepted",
      p_wamid: accepted.messageId,
      p_error_summary: null,
    });
    revalidatePath("/dashboard/meta");
    if (updateError) {
      return {
        error: "Meta accepted the message, but its history could not be updated. Investigate before sending again.",
        success: "",
        messageId: accepted.messageId,
      };
    }
    return {
      error: "",
      success: "Meta accepted this test message. Delivery will be confirmed by a later webhook.",
      messageId: accepted.messageId,
    };
  } catch (error) {
    const knownRejection = error instanceof MetaApiError && error.definitiveRejection;
    const state = knownRejection ? "rejected" : "uncertain";
    const errorSummary = error instanceof MetaApiError ? `${error.category} (${error.httpStatus ?? "no HTTP status"})` : "unknown failure";
    const { error: updateError } = await admin.rpc("record_meta_test_send_result", {
      p_id: attempt.id,
      p_state: state,
      p_wamid: null,
      p_error_summary: errorSummary,
    });
    revalidatePath("/dashboard/meta");
    if (updateError) {
      return { ...emptyState, error: "The test outcome could not be recorded. Investigate the attempt before sending again." };
    }
    return {
      ...emptyState,
      error: knownRejection
        ? error instanceof MetaApiError ? error.message : "Meta rejected the test message."
        : "The request outcome is uncertain. Check Meta and the webhook history before sending again.",
    };
  }
}
