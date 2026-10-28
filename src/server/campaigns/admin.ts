import { cache } from "react";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { getWorkspaceRole } from "@/server/auth/staff-users/admin";
import { getConfiguredMetaIdentifiers, getMetaAccountHealth } from "@/server/meta/client";
import {
  assertApprovedMarketingTemplate,
  assertTemplateSnapshotUnchanged,
  syncMetaTemplates,
  type MetaTemplate,
} from "@/server/meta/templates";
import {
  assertCampaignId,
  CampaignStoreError,
  getCampaignStore,
  mapAudit,
  mapCampaign,
  mapCampaignRecipientPreview,
  mapCampaignTemplateReview,
  mapCounts,
  type CampaignDetail,
  type CampaignSummary,
} from "./store";

export class CampaignAccessError extends Error {
  constructor(message = "Campaign access is denied.") {
    super(message);
    this.name = "CampaignAccessError";
  }
}

export class CampaignInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignInputError";
  }
}

// Admin or staff may work with campaigns. Cached per request: one page render calls this several
// times, but Supabase Auth is asked once.
export const requireWorkspaceActor = cache(async (): Promise<string> => {
  const session = await createSessionClient();
  const { data, error } = await session.auth.getUser();
  const user = data.user;
  if (error || !user?.email_confirmed_at || !getWorkspaceRole(user)) {
    throw new CampaignAccessError();
  }
  return user.id;
});

function validateBodyParameters(value: string[] | undefined): string[] {
  const parameters = value ?? [];
  if (!Array.isArray(parameters) || parameters.length > 20 ||
      parameters.some((part) => typeof part !== "string" || !part.trim() || part.length > 1024)) {
    throw new CampaignInputError("One of the values is empty or too long (the limit is 1,024 characters). Check each line.");
  }
  return parameters;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function approvedTemplate(
  name: string,
  language: string,
  parameters: string[],
  headerMediaUrl?: string,
): Promise<MetaTemplate> {
  const [health, snapshot] = await Promise.all([getMetaAccountHealth(), syncMetaTemplates()]);
  if (!health.phoneBelongsToWaba) {
    throw new CampaignInputError("The WhatsApp number is not connected to this business account. Check WhatsApp setup.");
  }
  const template = snapshot.templates.find(
    (item) => item.name === name && item.language === language,
  );
  if (!template) throw new CampaignInputError("That template is not available any more. Refresh the page and choose another.");
  const validation = assertApprovedMarketingTemplate(template, parameters, headerMediaUrl);
  if (validation.headerFormat === "IMAGE" && !headerMediaUrl?.trim()) {
    throw new CampaignInputError("This template needs a header image. Please upload a JPG or PNG.");
  }
  return template;
}

export type CreateCampaignDraftInput = {
  name: string;
  templateName: string;
  languageCode: string;
  bodyParameters?: string[];
  headerMediaUrl?: string;
  audienceSource: "import_batch" | "all_eligible";
  importBatchId?: string;
};

/** Creates a frozen audience for review. It never sends or schedules messages. */
export async function createCampaignDraft(
  input: CreateCampaignDraftInput,
): Promise<CampaignSummary> {
  const actorId = await requireWorkspaceActor();
  const name = input.name?.trim();
  if (!name || name.length > 120) throw new CampaignInputError("Enter a campaign name (up to 120 characters).");
  if (!/^[a-z0-9_]{1,512}$/.test(input.templateName) ||
      !/^[A-Za-z]{2,8}(?:_[A-Za-z0-9]{2,8})?$/.test(input.languageCode)) {
    throw new CampaignInputError("Choose a template from the list.");
  }
  const parameters = validateBodyParameters(input.bodyParameters);
  const headerMediaUrl = input.headerMediaUrl?.trim() || undefined;
  if (headerMediaUrl !== undefined) {
    if (!/^https:\/\/[^\s$.?#].[^\s]*$/i.test(headerMediaUrl)) {
      throw new CampaignInputError("The header image could not be used. Please upload it again.");
    }
  }
  const audienceSource = input.audienceSource;
  const importBatchId = input.importBatchId;
  if ((audienceSource !== "import_batch" && audienceSource !== "all_eligible") ||
      (audienceSource === "import_batch" &&
        (typeof importBatchId !== "string" || !uuidPattern.test(importBatchId))) ||
      (audienceSource === "all_eligible" && importBatchId !== undefined)) {
    throw new CampaignInputError("Choose a contact list for this campaign.");
  }
  const { wabaId, phoneNumberId } = getConfiguredMetaIdentifiers();
  const template = await approvedTemplate(input.templateName, input.languageCode, parameters, headerMediaUrl);
  const store = getCampaignStore();
  const { data, error } = await store.rpc("create_whatsapp_campaign_draft", {
    p_created_by: actorId,
    p_name: name,
    p_waba_id: wabaId,
    p_phone_number_id: phoneNumberId,
    p_template_id: template.id,
    p_template_name: template.name,
    p_template_language: template.language,
    p_template_snapshot: template,
    p_body_parameters: parameters,
    p_import_batch_id: audienceSource === "import_batch" ? importBatchId : null,
    p_all_eligible: audienceSource === "all_eligible",
  });
  if (error) throw new CampaignStoreError("The campaign could not be saved. Please try again.");
  if (headerMediaUrl && data?.id) {
    await store.from("whatsapp_campaigns")
      .update({ header_media_url: headerMediaUrl })
      .eq("id", data.id);
  }
  return mapCampaign(data);
}

function futureIso(value: string): string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new CampaignInputError("Pick a date and time to send.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.valueOf() <= Date.now()) {
    throw new CampaignInputError("Pick a time in the future.");
  }
  return date.toISOString();
}

async function currentCampaignForTransition(id: string) {
  assertCampaignId(id);
  const store = getCampaignStore();
  const { data, error } = await store.from("whatsapp_campaigns")
    .select("id,state,waba_id,phone_number_id,template_id,template_name,template_language,template_snapshot,body_parameters,header_media_url,audience_count,review_sha256")
    .eq("id", id).single();
  if (error || !data) throw new CampaignStoreError("This campaign could not be found. It may have been deleted.");
  return data;
}

async function recheckCampaignTemplate(id: string): Promise<void> {
  const campaign = await currentCampaignForTransition(id);
  const { wabaId, phoneNumberId } = getConfiguredMetaIdentifiers();
  if (campaign.waba_id !== wabaId || campaign.phone_number_id !== phoneNumberId) {
    throw new CampaignInputError("The WhatsApp number changed after this campaign was created. Please create a new campaign.");
  }
  const parameters = validateBodyParameters(campaign.body_parameters);
  const headerMediaUrl = typeof campaign.header_media_url === "string" && campaign.header_media_url
    ? campaign.header_media_url : undefined;
  const template = await approvedTemplate(
    campaign.template_name,
    campaign.template_language,
    parameters,
    headerMediaUrl,
  );
  if (template.id !== campaign.template_id) {
    throw new CampaignInputError("The template was changed in WhatsApp after you created this campaign. Please create a new campaign to use the latest version.");
  }
  assertTemplateSnapshotUnchanged(template, campaign.template_snapshot);
}

async function transition(
  id: string,
  action: "schedule" | "pause" | "resume" | "cancel",
  scheduledFor: string | null = null,
  review: CampaignReviewAcknowledgment | null = null,
): Promise<CampaignSummary> {
  const actorId = await requireWorkspaceActor();
  assertCampaignId(id);
  if (action === "schedule") {
    if (!review?.acknowledged || !Number.isSafeInteger(review.audienceCount) ||
        review.audienceCount < 1 || !/^[0-9a-f]{64}$/.test(review.reviewSha256)) {
      throw new CampaignInputError("Please tick the box to confirm you checked the message and the recipients.");
    }
    const current = await currentCampaignForTransition(id);
    if (current.audience_count !== review.audienceCount ||
        current.review_sha256 !== review.reviewSha256) {
      throw new CampaignInputError("This campaign changed while you were looking at it. Refresh the page and check it again.");
    }
  }
  if (action === "schedule" || action === "resume") await recheckCampaignTemplate(id);
  const store = getCampaignStore();
  const { data, error } = await store.rpc("transition_whatsapp_campaign", {
    p_campaign_id: id,
    p_actor_user_id: actorId,
    p_action: action,
    p_scheduled_for: scheduledFor,
    p_review_acknowledged: action === "schedule" ? review?.acknowledged === true : false,
    p_expected_audience_count: action === "schedule" ? review?.audienceCount : null,
    p_expected_review_sha256: action === "schedule" ? review?.reviewSha256 : null,
  });
  if (error) throw new CampaignStoreError("That action could not be completed. Please try again.");
  return mapCampaign(data);
}

export type CampaignReviewAcknowledgment = {
  acknowledged: true;
  audienceCount: number;
  reviewSha256: string;
};

export async function scheduleCampaign(
  id: string,
  scheduledForIso: string,
  review: CampaignReviewAcknowledgment,
) {
  return transition(id, "schedule", futureIso(scheduledForIso), review);
}

export async function pauseCampaign(id: string) {
  return transition(id, "pause");
}

export async function resumeCampaign(id: string) {
  return transition(id, "resume");
}

export async function cancelCampaign(id: string) {
  return transition(id, "cancel");
}

/** Deletes a draft that was never scheduled. Any other state is refused by the database. */
export async function deleteDraftCampaign(id: string): Promise<void> {
  await requireWorkspaceActor();
  const store = getCampaignStore();
  const { error } = await store.rpc("delete_draft_campaign", { p_campaign_id: id });
  if (error) {
    throw new CampaignStoreError(/draft/i.test(error.message ?? "")
      ? "Only a draft campaign can be deleted."
      : "The draft could not be deleted. Apply drizzle/0021_delete_draft_campaign.sql and try again.");
  }
}

export const CAMPAIGNS_PAGE_SIZE = 10;

export async function listCampaigns(page = 1): Promise<{ items: CampaignSummary[]; total: number }> {
  await requireWorkspaceActor();
  const store = getCampaignStore();
  const from = (Math.max(1, page) - 1) * CAMPAIGNS_PAGE_SIZE;
  const { data, error, count } = await store.from("whatsapp_campaigns")
    .select("id,name,state,audience_source,import_batch_id,audience_source_label,template_name,template_language,scheduled_for,audience_count,created_at", { count: "exact" })
    .order("created_at", { ascending: false }).order("id")
    .range(from, from + CAMPAIGNS_PAGE_SIZE - 1);
  if (error) throw new CampaignStoreError("Campaigns could not be loaded. Please refresh the page.");
  return { items: (data ?? []).map(mapCampaign), total: count ?? 0 };
}

export type CampaignImportBatchOption = {
  id: string;
  fileName: string;
  createdAt: string;
  acceptedRows: number;
  pendingClaims: number;
};

export async function listCampaignImportBatches(): Promise<CampaignImportBatchOption[]> {
  await requireWorkspaceActor();
  const store = getCampaignStore();
  const { data, error } = await store.from("contact_import_batches")
    .select("id,file_name,created_at,accepted_rows,pending_claims")
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw new CampaignStoreError("Your contact lists could not be loaded. Please refresh the page.");
  return (data ?? []).map((item) => ({
    id: item.id,
    fileName: item.file_name,
    createdAt: item.created_at,
    acceptedRows: item.accepted_rows,
    pendingClaims: item.pending_claims,
  }));
}

export const RECIPIENTS_PAGE_SIZE = 15;
export const AUDIT_PAGE_SIZE = 10;

export async function getCampaignDetail(
  id: string,
  pages: { recipientPage?: number; auditPage?: number } = {},
): Promise<CampaignDetail & { recipientTotal: number; auditTotal: number }> {
  await requireWorkspaceActor();
  assertCampaignId(id);
  const store = getCampaignStore();
  const recipientFrom = (Math.max(1, pages.recipientPage ?? 1) - 1) * RECIPIENTS_PAGE_SIZE;
  const auditFrom = (Math.max(1, pages.auditPage ?? 1) - 1) * AUDIT_PAGE_SIZE;
  const [campaignResult, countsResult, auditResult, recipientResult] = await Promise.all([
    store.from("whatsapp_campaigns")
      .select("id,name,state,audience_source,import_batch_id,audience_source_label,template_name,template_language,template_snapshot,body_parameters,header_media_url,review_sha256,scheduled_for,audience_count,created_at")
      .eq("id", id).single(),
    store.rpc("whatsapp_campaign_counts", { p_campaign_id: id }),
    store.from("whatsapp_campaign_audit").select("action,created_at,detail", { count: "exact" })
      .eq("campaign_id", id).order("created_at", { ascending: false })
      .range(auditFrom, auditFrom + AUDIT_PAGE_SIZE - 1),
    store.from("whatsapp_campaign_recipients")
      .select("contact_id,recipient_e164,state", { count: "exact" })
      .eq("campaign_id", id).order("created_at", { ascending: true }).order("id")
      .range(recipientFrom, recipientFrom + RECIPIENTS_PAGE_SIZE - 1),
  ]);
  if (campaignResult.error || !campaignResult.data || countsResult.error ||
      auditResult.error || recipientResult.error) {
    throw new CampaignStoreError("This campaign could not be loaded. Please refresh the page.");
  }
  const recipients = (recipientResult.data ?? []).map(mapCampaignRecipientPreview);
  const contactIds = recipients.map((recipient) => recipient.contactId);
  const contactsResult = contactIds.length
    ? await store.from("contacts").select("id,display_name").in("id", contactIds)
    : null;
  if (contactsResult?.error) throw new CampaignStoreError("The recipient list could not be loaded. Please refresh the page.");
  const names = new Map<string, string | null>();
  for (const contact of contactsResult?.data ?? []) {
    if (typeof contact.id === "string") {
      names.set(contact.id,
        typeof contact.display_name === "string" ? contact.display_name : null);
    }
  }
  return {
    recipientTotal: recipientResult.count ?? 0,
    auditTotal: auditResult.count ?? 0,
    ...mapCampaign(campaignResult.data),
    ...mapCampaignTemplateReview(campaignResult.data),
    counts: mapCounts(countsResult.data),
    audit: (auditResult.data ?? []).map(mapAudit),
    recipientPreview: recipients.map((recipient) => ({
      ...recipient,
      displayName: names.get(recipient.contactId) ?? null,
    })),
  };
}

const EXCLUDED_MARKER = "Excluded before sending";

/** Normalizes pasted numbers (any spacing, with or without +) to E.164; reports what it could not read. */
export function parsePastedPhones(text: string): { phones: string[]; invalid: string[] } {
  const phones = new Set<string>();
  const invalid: string[] = [];
  for (const piece of text.split(/[\n,;]+/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const digits = trimmed.replace(/^00/, "").replace(/[^0-9]/g, "");
    if (/^[1-9][0-9]{7,14}$/.test(digits)) phones.add(`+${digits}`);
    else invalid.push(trimmed.slice(0, 40));
  }
  return { phones: [...phones], invalid };
}

export async function setCampaignExclusions(
  id: string, phones: string[] | null, restore: boolean,
): Promise<{ changed: number; audienceCount: number }> {
  await requireWorkspaceActor();
  assertCampaignId(id);
  const { data, error } = await getCampaignStore().rpc("set_campaign_recipient_exclusions", {
    p_campaign_id: id, p_phones: phones, p_restore: restore,
  });
  if (error) {
    throw new CampaignStoreError(/before the campaign is scheduled/i.test(error.message)
      ? "Numbers can only be skipped while the campaign is still a draft."
      : "The numbers could not be updated. Apply drizzle/0017_exclude_campaign_recipients.sql.");
  }
  const result = (data ?? {}) as { changed?: number; audience_count?: number };
  return { changed: Number(result.changed ?? 0), audienceCount: Number(result.audience_count ?? 0) };
}

export async function listExcludedRecipients(id: string): Promise<{ phone: string; name: string | null }[]> {
  await requireWorkspaceActor();
  assertCampaignId(id);
  const store = getCampaignStore();
  const { data, error } = await store.from("whatsapp_campaign_recipients")
    .select("contact_id,recipient_e164").eq("campaign_id", id)
    .eq("state", "canceled").eq("error_summary", EXCLUDED_MARKER).order("recipient_e164").limit(500);
  if (error) throw new CampaignStoreError("The skipped numbers could not be loaded. Please refresh the page.");
  const ids = (data ?? []).map((row) => row.contact_id as string);
  const names = new Map<string, string | null>();
  if (ids.length) {
    const contacts = await store.from("contacts").select("id,display_name").in("id", ids);
    for (const c of contacts.data ?? []) names.set(c.id as string, (c.display_name as string | null) ?? null);
  }
  return (data ?? []).map((row) => ({ phone: row.recipient_e164 as string, name: names.get(row.contact_id as string) ?? null }));
}
