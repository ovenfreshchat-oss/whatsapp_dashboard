import { unstable_cache } from "next/cache";
import { getMetaAccountHealth, listMetaWebhookSubscriptions } from "./client";
import { syncMetaTemplates } from "./templates";

/**
 * Read-only Meta lookups for page renders, cached for a minute. Each one is one or more calls to
 * Meta's Graph API (hundreds of ms each), so pages that only display the result should not make
 * them on every load. Sending, scheduling and the campaign worker keep using the live versions.
 */
export const getMetaAccountHealthCached = unstable_cache(getMetaAccountHealth, ["meta-account-health"], { revalidate: 60 });
export const listMetaWebhookSubscriptionsCached = unstable_cache(listMetaWebhookSubscriptions, ["meta-webhook-subscriptions"], { revalidate: 60 });
export const syncMetaTemplatesCached = unstable_cache(syncMetaTemplates, ["meta-templates-sync"], { revalidate: 60 });
