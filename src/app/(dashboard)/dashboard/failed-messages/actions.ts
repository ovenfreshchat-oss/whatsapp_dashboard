"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createStaffAdminClient, getWorkspaceAccess } from "@/server/auth/staff-users/admin";
import { startCampaignSendWorkflow } from "@/server/campaigns/start-send";
import { parseCampaignFilter } from "@/server/campaigns/retries";
import { parseRetryDelays } from "@/server/campaigns/retry-math";

export type RetryActionState = { error: string; success: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+[1-9][0-9]{7,14}$/;

async function actor() {
  if (await getWorkspaceAccess() !== "allowed") return null;
  const session = await createClient();
  const { data, error } = await session.auth.getUser();
  const admin = createStaffAdminClient();
  if (error || !data.user || !admin) return null;
  return { admin, userId: data.user.id };
}

const DENIED = { error: "You don't have permission to do this.", success: "" };
const FAILED = { error: "That did not work. Check that drizzle/0026_failed_message_retries.sql is applied, then try again.", success: "" };

/** "Retry Failed Messages": queues every 131049 failure whose waiting time has passed. Never immediate. */
export async function retryFailedMessagesAction(_previous: RetryActionState, form: FormData): Promise<RetryActionState> {
  const campaignId = parseCampaignFilter(form.get("campaignId"));
  const who = await actor();
  if (!who) return DENIED;
  const { data, error } = await who.admin.rpc("retry_failed_messages", { p_campaign_id: campaignId, p_actor_user_id: who.userId });
  if (error) return FAILED;
  const result = (data ?? {}) as { queued?: number; not_ready_yet?: number };
  const queued = Number(result.queued ?? 0);
  const waiting = Number(result.not_ready_yet ?? 0);
  if (queued > 0) await startCampaignSendWorkflow().catch(() => false);
  revalidatePath("/dashboard/failed-messages");
  const tail = waiting > 0 ? ` ${waiting} more ${waiting === 1 ? "is" : "are"} still waiting for the safe delay and will not be retried yet.` : "";
  return {
    error: "",
    success: queued > 0
      ? `${queued} ${queued === 1 ? "message was" : "messages were"} queued. They send inside your sending window, one at a time.${tail}`
      : `Nothing to retry right now.${tail}`,
  };
}

/** "Enable Auto Retry" (or turn it off) for one campaign, with the three delays in hours. */
export async function setAutoRetryAction(_previous: RetryActionState, form: FormData): Promise<RetryActionState> {
  const campaignId = form.get("campaignId");
  const enable = form.get("enabled") === "true";
  if (typeof campaignId !== "string" || !UUID.test(campaignId)) return { error: "Choose a campaign first.", success: "" };
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
  revalidatePath("/dashboard/failed-messages");
  return {
    error: "",
    success: enable
      ? `Auto retry is on. ${Number(result.scheduled ?? 0)} failed ${Number(result.scheduled ?? 0) === 1 ? "message is" : "messages are"} scheduled. Each gets at most 3 retries.`
      : `Auto retry is off. ${Number(result.canceled ?? 0)} waiting automatic ${Number(result.canceled ?? 0) === 1 ? "retry was" : "retries were"} canceled.`,
  };
}

/** Manual review: a person confirms the number is fine, so it can receive campaigns again. */
export async function reactivateContactAction(_previous: RetryActionState, form: FormData): Promise<RetryActionState> {
  const phone = form.get("phone");
  const note = form.get("note");
  if (typeof phone !== "string" || !PHONE.test(phone) || (note !== null && typeof note !== "string")) {
    return { error: "That phone number is not valid.", success: "" };
  }
  const who = await actor();
  if (!who) return DENIED;
  const { data, error } = await who.admin.rpc("reactivate_contact_delivery", {
    p_phone: phone, p_actor_user_id: who.userId, p_note: (typeof note === "string" ? note.trim().slice(0, 500) : "") || null,
  });
  if (error || data !== true) return FAILED;
  revalidatePath("/dashboard/failed-messages");
  revalidatePath("/dashboard/contacts");
  return { error: "", success: `${phone} can receive campaigns again.` };
}

/** Marks a Meta number restriction (131048) as handled, so paused retries can resume. */
export async function resolveSenderAlertAction(_previous: RetryActionState, form: FormData): Promise<RetryActionState> {
  const id = form.get("alertId");
  if (typeof id !== "string" || !UUID.test(id)) return { error: "That alert was not found.", success: "" };
  const who = await actor();
  if (!who) return DENIED;
  const { data, error } = await who.admin.rpc("resolve_sender_alert", { p_alert_id: id, p_actor_user_id: who.userId });
  if (error || data !== true) return FAILED;
  revalidatePath("/dashboard/failed-messages");
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/campaigns");
  return { error: "", success: "Marked as handled. Campaigns on this number stay paused until you resume them." };
}
