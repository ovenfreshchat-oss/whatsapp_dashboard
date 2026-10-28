import { syncMetaTemplatesCached } from "@/server/meta/cached";
import { getMetaConfigurationStatus } from "@/server/meta/client";
import { toCategory, type MessageCategory } from "@/components/ui/badges";

/**
 * Message category (Marketing, Utility, Authentication) for each template a campaign can use,
 * keyed "name|language". Read from Meta's cached template list, so it adds no extra API call per
 * page load. If Meta cannot be reached the map is empty and callers use the fallback below.
 */
export async function getTemplateCategories(): Promise<Map<string, MessageCategory>> {
  const map = new Map<string, MessageCategory>();
  try {
    if (!getMetaConfigurationStatus().configured) return map;
    const result = await syncMetaTemplatesCached();
    for (const template of result?.templates ?? []) {
      const category = toCategory(template.category);
      if (category) map.set(`${template.name}|${template.language}`, category);
    }
  } catch {
    // Category colours are cosmetic; never fail the page because Meta is slow or unavailable.
  }
  return map;
}

/**
 * Campaigns can only be created from approved marketing templates, so a campaign whose template
 * is no longer listed by Meta (deleted or renamed) is still shown as Marketing.
 */
export function categoryForCampaign(
  categories: Map<string, MessageCategory>,
  campaign: { templateName: string; templateLanguage: string },
): MessageCategory {
  return categories.get(`${campaign.templateName}|${campaign.templateLanguage}`) ?? "MARKETING";
}
