import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";
import { getCampaignAnalytics } from "@/server/campaigns/analytics";
import { estimateCost, getCategoryVolumes, getMetaBilledCost, getRateCard, listCampaignPhones } from "@/server/campaigns/pricing";
import { getMetaAccountHealthCached } from "@/server/meta/cached";
import { createStaffAdminClient, isStaffAdminEmail } from "@/server/auth/staff-users/admin";
import styles from "./dashboard.module.css";

export const metadata: Metadata = {
  title: "Dashboard | The Oven Fresh",
};

const QUALITY: Record<string, { label: string; className: "qualityLow" | "qualityMedium" | "qualityHigh" }> = {
  RED: { label: "Low", className: "qualityLow" },
  YELLOW: { label: "Medium", className: "qualityMedium" },
  GREEN: { label: "High", className: "qualityHigh" },
};

type IconName = "contacts" | "templates" | "campaigns" | "team" | "optout";

function MetricIcon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {name === "contacts" && (
        <>
          <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.7" />
          <path d="M3.7 19v-1.2A5.3 5.3 0 0 1 9 12.5h.1a5.3 5.3 0 0 1 5.2 5.3V19H3.7ZM17 6.5a2.5 2.5 0 0 1 0 5M16.7 14a4 4 0 0 1 3.6 4v1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {name === "templates" && (
        <>
          <rect x="4" y="3.5" width="16" height="17" rx="3" stroke="currentColor" strokeWidth="1.7" />
          <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      )}
      {name === "campaigns" && (
        <>
          <path d="m4 10 11-5v14L4 14v-4ZM15 8.5l4.2-1.8v10.6L15 15.5M7 15.4l1.3 4.1h3" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}
      {name === "optout" && (
        <>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
          <path d="M6 6l12 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      )}
      {name === "team" && (
        <>
          <path d="M12 3.5 5 6.2v5.3c0 4.2 2.8 7.3 7 9 4.2-1.7 7-4.8 7-9V6.2L12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="m9 12 2.2 2.2L15.5 10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) redirect("/sign-in");

  const user = data.user;
  const canAddStaff = Boolean(user.email_confirmed_at && isStaffAdminEmail(user.email));
  if (user.app_metadata?.role !== "staff" && !canAddStaff) redirect("/access-denied");

  const metaSettingsPresent = [
    process.env.META_GRAPH_API_VERSION,
    process.env.META_WABA_ID,
    process.env.META_PHONE_NUMBER_ID,
    process.env.META_SYSTEM_USER_ACCESS_TOKEN,
    process.env.META_APP_SECRET,
    process.env.META_WEBHOOK_VERIFY_TOKEN,
  ].every(Boolean);
  const admin = canAddStaff ? createStaffAdminClient() : null;
  const [contactsResult, campaignsResult, activeResult, sentResult, optOutResult, repliesResult, deliveredResult, deliveredRepliesResult, categories] = admin
    ? await Promise.all([
        admin.from("contacts").select("id", { count: "exact", head: true }),
        admin.from("whatsapp_campaigns").select("id", { count: "exact", head: true }).neq("state", "draft"),
        admin.from("whatsapp_campaigns").select("id", { count: "exact", head: true })
          .in("state", ["scheduled", "running", "paused"]),
        admin.from("whatsapp_campaign_recipients").select("id", { count: "exact", head: true })
          .eq("state", "accepted"),
        admin.from("opt_out_numbers").select("phone_e164", { count: "exact", head: true }),
        admin.from("inbox_messages").select("id", { count: "exact", head: true })
          .eq("direction", "outbound").in("status", ["sent", "delivered", "read"]),
        admin.from("whatsapp_campaign_recipients").select("id", { count: "exact", head: true })
          .in("delivery_status", ["delivered", "read"]),
        admin.from("inbox_messages").select("id", { count: "exact", head: true })
          .eq("direction", "outbound").in("status", ["delivered", "read"]),
        getCategoryVolumes(),
      ])
    : [null, null, null, null, null, null, null, null, null];
  const count = (result: { count: number | null; error: unknown } | null) =>
    result && !result.error ? (result.count ?? 0) : null;
  const contactCount = count(contactsResult);
  const show = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US"));
  const campaignSent = count(sentResult);
  const replySent = count(repliesResult);
  const totalSent = campaignSent === null ? null : campaignSent + (replySent ?? 0);
  const campaignDelivered = count(deliveredResult);
  const totalDelivered = campaignDelivered === null ? null : campaignDelivered + (count(deliveredRepliesResult) ?? 0);
  const deliveredShare = totalSent && totalDelivered !== null ? `${Math.round((totalDelivered / totalSent) * 100)}% of sent` : "Campaigns and inbox replies";
  const metaNote = categories ? "Delivered, per Meta (12 months)" : "Not available from Meta yet";
  const metrics: { label: string; value: string; detail: string; icon: IconName; tone?: "marketing" | "utility" | "authentication" }[] = [
    { label: "Contacts", value: show(contactCount),
      detail: contactCount === null ? "Database setup needed" : "Saved numbers", icon: "contacts" },
    { label: "Messages sent", value: show(totalSent), detail: "Campaigns and inbox replies", icon: "templates" },
    { label: "Delivered", value: show(totalDelivered), detail: deliveredShare, icon: "contacts" },
    { label: "Opted out", value: show(count(optOutResult)), detail: "Never messaged", icon: "optout" },
    { label: "Campaigns", value: show(count(campaignsResult)),
      detail: count(campaignsResult) === null ? "Database setup needed" : `${count(activeResult) ?? 0} active now`, icon: "campaigns" },
    { label: "Marketing messages", value: show(categories ? categories.marketing : campaignSent),
      detail: categories ? metaNote : "Sent from campaigns", icon: "campaigns", tone: "marketing" },
    { label: "Utility messages", value: show(categories ? categories.utility : null), detail: metaNote, icon: "templates", tone: "utility" },
    { label: "Authentication messages", value: show(categories ? categories.authentication : null), detail: metaNote, icon: "team", tone: "authentication" },
  ];

  // Last campaign that actually went out (drafts, scheduled and canceled ones are ignored).
  const lastRowResult = admin
    ? await admin.from("whatsapp_campaigns").select("id,name,state,created_at")
        .in("state", ["running", "paused", "completed"]).order("created_at", { ascending: false }).limit(1)
    : null;
  const lastRow = lastRowResult && !lastRowResult.error ? lastRowResult.data?.[0] ?? null : null;
  const [analyticsResult, healthResult] = await Promise.allSettled([
    lastRow ? getCampaignAnalytics(lastRow.id) : Promise.resolve(null),
    canAddStaff && metaSettingsPresent ? getMetaAccountHealthCached() : Promise.resolve(null),
  ]);
  const last = analyticsResult.status === "fulfilled" ? analyticsResult.value : null;
  if (analyticsResult.status === "rejected") console.error("Dashboard last-campaign analytics failed", analyticsResult.reason);
  const quality = healthResult.status === "fulfilled" ? healthResult.value?.phoneNumber?.qualityRating ?? null : null;
  let price = "—";
  if (last) {
    try {
      const card = getRateCard();
      if (card) {
        const phones = await listCampaignPhones(last.campaign.id, { deliveryStatuses: ["delivered", "read"] });
        const estimate = estimateCost(phones, card);
        price = `${estimate.currency} ${estimate.total.toFixed(estimate.total < 1 ? 4 : 2)}`;
      } else if (last.firstAcceptedAt) {
        const billed = await getMetaBilledCost(
          new Date(Date.parse(last.firstAcceptedAt) - 30 * 60_000).toISOString(),
          new Date(Math.max(Date.parse(last.lastStatusAt ?? last.firstAcceptedAt), Date.parse(last.lastAcceptedAt ?? last.firstAcceptedAt)) + 60 * 60_000).toISOString());
        if (billed) price = billed.cost.toFixed(4);
      }
    } catch { /* price stays "—" */ }
  }
  const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
  const lastTiles: { label: string; value: string; detail: string }[] = last ? [
    { label: "Sent", value: show(last.accepted), detail: `of ${show(last.audience)} in audience` },
    { label: "Delivered", value: show(last.delivered), detail: `${share(last.delivered, last.accepted)} of sent` },
    { label: "Failed", value: show(last.failed + last.rejected), detail: `${last.failed} delivery · ${last.rejected} rejected` },
    { label: "Price", value: price, detail: "Delivered messages" },
    { label: "Responses", value: show(last.repliers), detail: `${last.replies} messages` },
    { label: "Opted out", value: show(last.optOuts), detail: `${share(last.optOuts, last.delivered)} of delivered` },
  ] : [];
  const qualityInfo = QUALITY[String(quality ?? "").toUpperCase()];
  const qualityLevel = String(quality ?? "").toUpperCase();
  const qualityStatus = qualityLevel === "GREEN"
    ? { tone: "statusHigh", title: "High", text: "You can proceed with your next campaign." }
    : qualityLevel === "YELLOW"
      ? { tone: "statusMedium", title: "Medium", text: "⚠️ Please wait until your quality rating returns to High before sending your next campaign." }
      : qualityLevel === "RED"
        ? { tone: "statusLow", title: "Low", text: "⚠️ Your quality rating is Low. Please wait until it returns to High before sending your next campaign." }
        : null;

  return (
    <DashboardShell
      label="The Oven Fresh dashboard"
      showMetaSetup={canAddStaff}
    >
      <div className={styles.content}>
        <div className={styles.headingRow}>
          <div>
            <span className={styles.eyebrow}>WORKSPACE OVERVIEW</span>
            <h1>Dashboard overview</h1>
            <p>Your contacts, campaigns, and team in one place.</p>
          </div>
          <span className={styles.activeBadge}><i aria-hidden="true" /> Workspace active</span>
        </div>

        {qualityStatus && <section className={`${styles.qualityStatus} ${styles[qualityStatus.tone]}`} aria-label="Quality rating status" role="status">
          <strong>Quality Rating Status: {qualityStatus.title}</strong>
          <p>{qualityStatus.text}</p>
        </section>}

        <section className={styles.metrics} aria-label="Workspace metrics">
          {metrics.map((metric) => (
            <article className={[styles.metricCard, metric.tone ? styles[metric.tone] : ""].filter(Boolean).join(" ")} key={metric.label}>
              <div className={styles.metricTop}>
                <span>{metric.label}</span>
                <span className={styles.metricIcon}><MetricIcon name={metric.icon} /></span>
              </div>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
            </article>
          ))}
        </section>

        <section className={styles.lastCampaign} aria-labelledby="last-campaign-heading">
          <div className={styles.lastHead}>
            <div>
              <span className={styles.eyebrow}>LAST CAMPAIGN</span>
              <h2 id="last-campaign-heading">{last ? last.campaign.name : "No campaign sent yet"}</h2>
              {last && <p>{last.campaign.state} · {last.campaign.createdAt.slice(0, 10)}</p>}
            </div>
            {last && <Link href={`/dashboard/campaigns/${last.campaign.id}/analytics`} className={styles.lastLink}>Full analytics →</Link>}
          </div>
          {last ? <div className={styles.lastGrid}>
            {lastTiles.map((tile) => <article key={tile.label} className={styles.lastTile}>
              <span>{tile.label}</span><strong>{tile.value}</strong><small>{tile.detail}</small>
            </article>)}
            <article className={styles.lastTile}>
              <span>Number quality</span>
              <strong>{qualityInfo ? <span className={`${styles.quality} ${styles[qualityInfo.className]}`}><i aria-hidden="true" />{qualityInfo.label}</span> : "—"}</strong>
              <small>{qualityInfo ? "WhatsApp quality rating" : quality ? "Unknown rating" : "Not available from Meta"}</small>
            </article>
          </div> : <p className={styles.lastEmpty}>{lastRow ? <>Results for “{lastRow.name}” could not be loaded right now. <Link href={`/dashboard/campaigns/${lastRow.id}`}>Open campaign</Link></> : lastRowResult && !lastRowResult.error ? <>Send your first campaign to see its results here. <Link href="/dashboard/campaigns">Open campaigns</Link></> : "Campaign data is unavailable. Check the database setup."}</p>}
        </section>
      </div>
    </DashboardShell>
  );
}
