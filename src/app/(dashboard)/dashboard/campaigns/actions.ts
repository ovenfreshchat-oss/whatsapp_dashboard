"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getStaffAdminAccess } from "@/server/auth/staff-users/admin";
import {
  CampaignAccessError,
  CampaignInputError,
  cancelCampaign,
  createCampaignDraft,
  pauseCampaign,
  resumeCampaign,
  scheduleCampaign,
} from "@/server/campaigns/admin";
import { CampaignStoreError } from "@/server/campaigns/store";
import { MetaApiError } from "@/server/meta/client";

export type CampaignActionState = { error: string; success: string };

/** Long enough for the template recheck before the database requires a future time. */
const SEND_NOW_DELAY_MS = 45_000;

function safeError(error: unknown): string {
  if (error instanceof CampaignAccessError) return "Only a workspace admin can manage campaigns.";
  if (error instanceof CampaignInputError || error instanceof CampaignStoreError ||
      error instanceof MetaApiError) return error.message;
  return "The campaign could not be updated. Check the setup and try again.";
}

export async function createCampaignDraftAction(
  _previous: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "Only a workspace admin can create campaigns.", success: "" };
  }
  const name = formData.get("name");
  const templateKey = formData.get("templateKey");
  const rawParameters = formData.get("bodyParameters");
  const selectedAudience = formData.get("audienceSource");
  if (typeof name !== "string" || typeof templateKey !== "string" ||
      typeof rawParameters !== "string" || typeof selectedAudience !== "string") {
    return { error: "Enter a campaign name and choose an approved template.", success: "" };
  }
  const [templateName, languageCode, extra] = templateKey.split("|");
  if (!templateName || !languageCode || extra !== undefined) {
    return { error: "Choose a valid approved template.", success: "" };
  }
  const bodyParameters = rawParameters.trim()
    ? rawParameters.replace(/\r/g, "").split("\n").map((value) => value.trim()).filter((value) => value.length > 0)
    : [];
  const rawHeaderMediaUrl = formData.get("headerMediaUrl");
  const headerMediaUrl = typeof rawHeaderMediaUrl === "string" && rawHeaderMediaUrl.trim()
    ? rawHeaderMediaUrl.trim() : undefined;
  const batchMatch = /^batch:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    .exec(selectedAudience);
  if (selectedAudience !== "all" && !batchMatch) {
    return { error: "Choose a specific import file or explicitly choose all eligible contacts.", success: "" };
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

export async function transitionCampaignAction(
  campaignId: string,
  _previous: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  if (await getStaffAdminAccess() !== "allowed") {
    return { error: "Only a workspace admin can manage campaigns.", success: "" };
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
        return { error: "Review the message and frozen audience before sending.", success: "" };
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
  revalidatePath("/dashboard/campaigns");
  revalidatePath(`/dashboard/campaigns/${campaignId}`);
  return {
    error: "",
    success: intent === "send_now"
      ? "Campaign queued. The worker starts sending within a minute if it is running and inside its sending window."
      : "Campaign updated.",
  };
}
