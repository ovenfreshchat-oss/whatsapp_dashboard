import { unstable_cache } from "next/cache";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { getCategoryVolumes } from "@/server/campaigns/pricing";

export type WorkspaceMetrics = {
  contacts: number | null;
  campaigns: number | null;
  activeCampaigns: number | null;
  campaignSent: number | null;
  replySent: number | null;
  optedOut: number | null;
  campaignDelivered: number | null;
  replyDelivered: number | null;
  categories: { marketing: number; utility: number; authentication: number } | null;
};

type CountResult = { count: number | null; error: unknown } | null;
const count = (result: CountResult): number | null => (result && !result.error ? (result.count ?? 0) : null);

async function fetchMetrics(): Promise<WorkspaceMetrics | null> {
  const admin = createStaffAdminClient();
  if (!admin) return null;
  const [contacts, campaigns, active, sent, optOut, replies, delivered, deliveredReplies, categories] = await Promise.all([
    admin.from("contacts").select("id", { count: "exact", head: true }),
    admin.from("whatsapp_campaigns").select("id", { count: "exact", head: true }).neq("state", "draft"),
    admin.from("whatsapp_campaigns").select("id", { count: "exact", head: true }).in("state", ["scheduled", "running", "paused"]),
    admin.from("whatsapp_campaign_recipients").select("id", { count: "exact", head: true }).eq("state", "accepted"),
    admin.from("opt_out_numbers").select("phone_e164", { count: "exact", head: true }),
    admin.from("inbox_messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").in("status", ["sent", "delivered", "read"]),
    admin.from("whatsapp_campaign_recipients").select("id", { count: "exact", head: true }).in("delivery_status", ["delivered", "read"]),
    admin.from("inbox_messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").in("status", ["delivered", "read"]),
    getCategoryVolumes(),
  ]);
  return {
    contacts: count(contacts),
    campaigns: count(campaigns),
    activeCampaigns: count(active),
    campaignSent: count(sent),
    replySent: count(replies),
    optedOut: count(optOut),
    campaignDelivered: count(delivered),
    replyDelivered: count(deliveredReplies),
    categories: categories ?? null,
  };
}

/**
 * Eight count queries plus a Meta lookup ran on every dashboard visit. The numbers are the same
 * for every admin, so they are shared and refreshed every 30 seconds instead.
 */
/** Uncached counts, for saving manual adjustments against the exact current numbers. */
export const getLiveMetrics = fetchMetrics;

export const getWorkspaceMetrics = unstable_cache(fetchMetrics, ["workspace-metrics"], { revalidate: 30 });
