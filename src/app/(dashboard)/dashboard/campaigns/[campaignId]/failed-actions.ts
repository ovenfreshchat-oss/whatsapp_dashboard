"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getWorkspaceAccess } from "@/server/auth/staff-users/admin";
import { startCampaignSendWorkflow } from "@/server/campaigns/start-send";
import { isUuid, previewFailedContacts, type FailedContactPreview } from "@/server/campaigns/retries";
import { parseRetryDelays } from "@/server/campaigns/retry-math";

export type RetryActionState = { error: string; success: string };

const PHONE = /^\+[1-9][0-9]{7,14}$/;
const MAX_SELECTION = 5000;

async function actor() {
  if (await getWorkspaceAccess() !== "allowed") return null;
  const session = await createClient();
  const { data, error } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (error || !data.user || !admin) return null;
  return { admin, userId: data.user.id };
}

const DENIED = { error: "You don't have permission to do this.", success: "" };
const FAILED = { error: "That did not work. Check that drizzle/0026 to 0028 are applied, then try again.", success: "" };

function refresh(campaignId: string | null) {
  if (campaignId) revalidatePath(`/dashboard/campaigns/${campaignId}`);
  revalidatePath("/dashboard");
}

/** "Retry Eligible": queues every 131049 failure of THIS campaign whose waiting time has passed. Never immediate. */
export async function retryFailedMessagesAction(_previous: RetryActionState, form: FormData): Promise<RetryActionState> {
  const campaignId = form.get("campaignId");
  if (!isUuid(campaignId)) return { error: "Open a campaign first. Retries always belong to one campaign.", success: "" };
  const who = await actor();
  if (!who) return DENIED;
  const { data, error } = await who.admin.rpc("retry_failed_messages", { p_campaign_id: campaignId, p_actor_user_id: who.userId });
  if (error) return FAILED;
  const result = (data ?? {}) as { queued?: number; not_ready_yet?: number };
  const queued = Number(result.queued ?? 0);
  const waiting = Number(result.not_ready_yet ?? 0);
  if (queued > 0) await startCampaignSendWorkflow().catch(() => false);
  refresh(campaignId);
  const tail = waiting > 0 ? ` ${waiting} more ${waiting === 1 ? "is" : "are"} still waiting for the safe delay and will not be retried yet.` : "";
  return {
    error: "",
    success: queued > 0
      ? `${queued} ${queued === 1 ? "message was" : "messages were"} queued. They send inside your sending window, one at a time.${tail}`
      : `Nothing to retry right now.${tail}`,
  };
}

/** Auto retry for one campaign, with the three delays in hours. Off by default. */
export async function setAutoRetryAction(_previous: RetryActionState, form: FormData): Promise<RetryActionState> {
  const campaignId = form.get("campaignId");
  const enable = form.get("enabled") === "true";
  if (!isUuid(campaignId)) return { error: "Open a campaign first.", success: "" };
  let delays: number[] | null = null;
  if (enable) {
    const parsed = parseRetryDelays([form.get("delay1"), form.get("delay2"), form.get("delay3")]);
    if (!parsed.ok) return { error: parsed.error, success: "" };
    delays = parsed.delays;
  }
  const who = await actor();
  if (!who) return DENIED;
  const { data, error } = await who.admin.rpc("set_campaign_auto_retry", {
    p_campaign_id: campaignId, p_enabled: enable, p_delays: delays, p_actor_user_id: who.userId,
  });
  if (error) return FAILED;
  const result = (data ?? {}) as { scheduled?: number; canceled?: number };
  if (enable && Number(result.scheduled ?? 0) > 0) await startCampaignSendWorkflow().catch(() => false);
  refresh(campaignId);
  return {
    error: "",
    success: enable
      ? `Auto retry is on. ${Number(result.scheduled ?? 0)} failed ${Number(result.scheduled ?? 0) === 1 ? "message is" : "messages are"} scheduled. Each gets at most 3 retries.`
      : `Auto retry is off. ${Number(result.canceled ?? 0)} waiting automatic ${Number(result.canceled ?? 0) === 1 ? "retry was" : "retries were"} canceled.`,
  };
}

/**
 * Manual review. A person confirms the number is fine. Allowed only after the hold has ended, and never for a
 * Global Opt Out. Reactivating clears this number's delivery holds only: opt-outs and suppressions are separate.
 */
export async function reactivateContactAction(_previous: RetryActionState, form: FormData): Promise<RetryActionState> {
  const phone = form.get("phone");
  const note = form.get("note");
  const campaignId = form.get("campaignId");
  if (typeof phone !== "string" || !PHONE.test(phone) || (note !== null && typeof note !== "string")) {
    return { error: "That phone number is not valid.", success: "" };
  }
  const who = await actor();
  if (!who) return DENIED;
  const state = await who.admin.rpc("contact_delivery_state", { p_phone: phone });
  const current = Array.isArray(state.data) ? state.data[0] as Record<string, unknown> | undefined : undefined;
  if (state.error || !current) return FAILED;
  if (current.status === "opt_out") return { error: "This number is on the Global Opt Out list. It cannot be reactivated here.", success: "" };
  const { data, error } = await who.admin.rpc("reactivate_contact_delivery", {
    p_phone: phone, p_actor_user_id: who.userId, p_note: (typeof note === "string" ? note.trim().slice(0, 500) : "") || null,
  });
  if (error || data !== true) return FAILED;
  refresh(isUuid(campaignId) ? campaignId : null);
  revalidatePath("/dashboard/contacts");
  return { error: "", success: `${phone} can receive campaigns again.` };
}

/** Marks a Meta number restriction (131048) as handled, so paused retries can resume. */
export async function resolveSenderAlertAction(_previous: RetryActionState, form: FormData): Promise<RetryActionState> {
  const id = form.get("alertId");
  if (!isUuid(id)) return { error: "That alert was not found.", success: "" };
  const who = await actor();
  if (!who) return DENIED;
  const { data, error } = await who.admin.rpc("resolve_sender_alert", { p_alert_id: id, p_actor_user_id: who.userId });
  if (error || data !== true) return FAILED;
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/campaigns");
  return { error: "", success: "Marked as handled. Campaigns on this number stay paused until you resume them." };
}

/** Eligible and excluded counts for the "new campaign from failed contacts" step. Null ids = all failed contacts. */
export async function previewFailedContactsAction(
  campaignId: string, failureIds: string[] | null,
): Promise<{ preview: FailedContactPreview | null; error: string }> {
  if (!isUuid(campaignId)) return { preview: null, error: "Open a campaign first." };
  if (failureIds !== null && (failureIds.length === 0 || failureIds.length > MAX_SELECTION || !failureIds.every(isUuid))) {
    return { preview: null, error: "Select at least one failed contact." };
  }
  if (await getWorkspaceAccess() !== "allowed") return { preview: null, error: "You don't have permission to do this." };
  const preview = await previewFailedContacts(campaignId, failureIds);
  return preview ? { preview, error: "" } : { preview: null, error: "The selection could not be checked. Try again." };
}
