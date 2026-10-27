"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getStaffAdminAccess } from "@/server/auth/staff-users/admin";
import {
  CampaignAccessError,
  CampaignInputError,
  cancelCampaign,
  createCampaignDraft,
  deleteDraftCampaign,
  pauseCampaign,
  resumeCampaign,
  parsePastedPhones,
  scheduleCampaign,
  setCampaignExclusions,
} from "@/server/campaigns/admin";
import { CampaignStoreError } from "@/server/campaigns/store";
import { startCampaignSendWorkflow } from "@/server/campaigns/start-send";
import { MetaApiError } from "@/server/meta/client";
import { uploadCampaignHeaderImage } from "@/server/campaigns/media";

export type CampaignActionState = { error: string; success: string };

/** Long enough for the template recheck before the database requires a future time. */
const SEND_NOW_DELAY_MS = 20_000;

function safeError(error: unknown): string {
  if (error instanceof CampaignAccessError) return "Only an admin can do this.";
  if (error instanceof CampaignInputError || error instanceof CampaignStoreError ||
      error instanceof MetaApiError) return error.message;
  return "Something went wrong. Please try again, and contact support if it keeps happening.";
}

export async function createCampaignDraftAction(
  _previous: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "Only an admin can do this.", success: "" };
  }
  const name = formData.get("name");
  const templateKey = formData.get("templateKey");
  const rawParameters = formData.get("bodyParameters");
  const selectedAudience = formData.get("audienceSource");
  if (typeof name !== "string" || typeof templateKey !== "string" ||
      typeof rawParameters !== "string" || typeof selectedAudience !== "string") {
    return { error: "Enter a campaign name and choose a template.", success: "" };
  }
  const [templateName, languageCode, extra] = templateKey.split("|");
  if (!templateName || !languageCode || extra !== undefined) {
    return { error: "Choose a template from the list.", success: "" };
  }
  const bodyParameters = rawParameters.trim()
    ? rawParameters.replace(/\r/g, "").split("\n").map((value) => value.trim()).filter((value) => value.length > 0)
    : [];
  let headerMediaUrl: string | undefined;
  const image = formData.get("headerImage");
  if (image instanceof File && image.size > 0) {
    try {
      headerMediaUrl = await uploadCampaignHeaderImage(image);
    } catch (error) {
      return { error: safeError(error), success: "" };
    }
  }
  const batchMatch = /^batch:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    .exec(selectedAudience);
  if (selectedAudience !== "all" && !batchMatch) {
    return { error: "Choose a contact list for this campaign.", success: "" };
  }
  let campaignId: string;
  try {
    const campaign = await createCampaignDraft({
      name,
      templateName,
      languageCode,
      bodyParameters,
      headerMediaUrl,
      audienceSource: batchMatch ? "import_batch" : "all_eligible",
      ...(batchMatch ? { importBatchId: batchMatch[1] } : {}),
    });
    campaignId = campaign.id;
  } catch (error) {
    return { error: safeError(error), success: "" };
  }
  revalidatePath("/dashboard/campaigns");
  redirect(`/dashboard/campaigns/${campaignId}`);
}

export async function deleteDraftCampaignAction(campaignId: string): Promise<{ error: string }> {
  if (await getStaffAdminAccess() !== "allowed") return { error: "Only an admin can do this." };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(campaignId)) return { error: "Invalid campaign." };
  try {
    await deleteDraftCampaign(campaignId);
  } catch (error) {
    return { error: safeError(error) };
  }
  revalidatePath("/dashboard/campaigns");
  revalidatePath("/dashboard");
  return { error: "" };
}

export async function transitionCampaignAction(
  campaignId: string,
  _previous: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "Only an admin can do this.", success: "" };
  }
  const intent = formData.get("intent");
  try {
    if (intent === "schedule" || intent === "send_now") {
      // "Send now" queues the campaign for a moment from now, computed on the server so the
      // browser clock cannot matter. The worker still enforces its sending window and every
      // per-recipient eligibility check before each message.
      const scheduledFor = intent === "send_now"
        ? new Date(Date.now() + SEND_NOW_DELAY_MS).toISOString()
        : formData.get("scheduledForIso");
      const audienceCount = formData.get("reviewAudienceCount");
      const reviewSha256 = formData.get("reviewSha256");
      if (typeof scheduledFor !== "string" || typeof audienceCount !== "string" ||
          typeof reviewSha256 !== "string" ||
          !/^[1-9]\d*$/.test(audienceCount) ||
          !Number.isSafeInteger(Number(audienceCount)) ||
          !/^[0-9a-f]{64}$/.test(reviewSha256) ||
          formData.get("reviewAcknowledged") !== "yes") {
        return { error: "Please tick the box to confirm you checked the message and the recipients.", success: "" };
      }
      await scheduleCampaign(campaignId, scheduledFor, {
        acknowledged: true,
        audienceCount: Number(audienceCount),
        reviewSha256,
      });
    } else if (intent === "pause") {
      await pauseCampaign(campaignId);
    } else if (intent === "resume") {
      await resumeCampaign(campaignId);
    } else if (intent === "cancel") {
      await cancelCampaign(campaignId);
    } else {
      return { error: "Choose a valid campaign action.", success: "" };
    }
  } catch (error) {
    return { error: safeError(error), success: "" };
  }
  // On Vercel this starts the sender run (a no-op locally, where `npm run worker` sends). A failure
  // here must not undo the transition: the campaign stays scheduled and the next start picks it up.
  let senderNote = "";
  if (intent === "schedule" || intent === "send_now" || intent === "resume") {
    try {
      await startCampaignSendWorkflow();
    } catch {
      senderNote = " Sending could not start automatically. Please press Resume again in a minute.";
    }
  }
  revalidatePath("/dashboard/campaigns");
  revalidatePath(`/dashboard/campaigns/${campaignId}`);
  return {
    error: "",
    success: (intent === "send_now"
      ? "Your campaign is queued. Sending starts within a minute, during your allowed sending hours."
      : "Campaign updated.") + senderNote,
  };
}

export async function excludeRecipientsAction(
  campaignId: string,
  _previous: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "Only an admin can do this.", success: "" };
  }
  const intent = formData.get("intent");
  try {
    if (intent === "restore_all") {
      const result = await setCampaignExclusions(campaignId, null, true);
      revalidatePath(`/dashboard/campaigns/${campaignId}`);
      return { error: "", success: `${result.changed} numbers put back. ${result.audienceCount} will be sent.` };
    }
    const raw = formData.get("numbers");
    if (typeof raw !== "string" || !raw.trim()) return { error: "Paste at least one phone number.", success: "" };
    const { phones, invalid } = parsePastedPhones(raw.slice(0, 20_000));
    if (!phones.length) return { error: "No valid phone numbers found. Include the country code.", success: "" };
    const result = await setCampaignExclusions(campaignId, phones, intent === "restore");
    revalidatePath(`/dashboard/campaigns/${campaignId}`);
    const missed = phones.length - result.changed;
    return {
      error: "",
      success: `${result.changed} numbers ${intent === "restore" ? "put back" : "skipped"}. ${result.audienceCount} will be sent.` +
        (missed > 0 ? ` ${missed} were not in this campaign's list.` : "") +
        (invalid.length ? ` Could not read: ${invalid.slice(0, 3).join(", ")}${invalid.length > 3 ? "…" : ""}.` : ""),
    };
  } catch (error) {
    return { error: safeError(error), success: "" };
  }
}
