import Link from "next/link";
import {
  AlertTriangle, BellRing, CheckCheck, CheckCircle2, Megaphone, Percent, Send, ShieldCheck, Sparkles,
  UserMinus, Users, type LucideIcon,
} from "lucide-react";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { getCampaignAnalytics } from "@/server/campaigns/analytics";
import { estimateCost, getBilledCostSnapshot, getRateCard, listCampaignPhones } from "@/server/campaigns/pricing";
import { getMetricAdjustments } from "@/server/dashboard/adjustments";
import { getWorkspaceMetrics } from "@/server/dashboard/metrics";
import { getMetaAccountHealthCached } from "@/server/meta/cached";
import { loadWhatsappTotals } from "@/server/campaigns/whatsapp-totals";
import { DeliveryFilters } from "./delivery-filters";
import { CampaignStateBadge, CategoryBadge } from "@/components/ui/badges";
import ui from "@/components/ui/ui.module.css";
import styles from "./dashboard.module.css";
import { formatDate, formatDateTime, getClientTimeZone } from "@/lib/timezone";

const metaSettingsPresent = () => [
  process.env.META_GRAPH_API_VERSION,
  process.env.META_WABA_ID,
  process.env.META_PHONE_NUMBER_ID,
  process.env.META_SYSTEM_USER_ACCESS_TOKEN,
  process.env.META_APP_SECRET,
  process.env.META_WEBHOOK_VERIFY_TOKEN,
].every(Boolean);

const QUALITY: Record<string, { label: string; className: "qualityLow" | "qualityMedium" | "qualityHigh" }> = {
  RED: { label: "Low", className: "qualityLow" },
  YELLOW: { label: "Medium", className: "qualityMedium" },
  GREEN: { label: "High", className: "qualityHigh" },
};

type Tone = "indigo" | "ink" | "green" | "red" | "coral" | "violet" | "teal" | "gold";

function MetricCard({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: LucideIcon; tone: Tone }) {
  return (
    <article className={`${styles.metricCard} ${styles[`tone_${tone}`]}`}>
      <span className={styles.metricIcon} aria-hidden="true"><Icon size={20} strokeWidth={2} /></span>
      <div className={styles.metricText}>
        <span className={styles.metricLabel}>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

/** Delivery and failure totals across campaigns, with a date range. Read only. */
export async function DeliverySection({ from, to }: { from: string | null; to: string | null }) {
  const totals = await loadWhatsappTotals(from, to);
  return <section aria-labelledby="delivery-heading" className={styles.categorySection}>
    <div className={styles.sectionHead}>
      <h2 id="delivery-heading">Delivery and failures</h2>
      <span>{totals.from} to {totals.to}</span>
    </div>
    <DeliveryFilters from={totals.from} to={totals.to} campaignId={null} campaigns={[]} timeZone={getClientTimeZone()} />
    <div className={styles.categoryGrid}>
      <MetricCard tone="ink" icon={Send} label="Messages sent" value={show(totals.sent)} detail="All messages, per WhatsApp" />
      <MetricCard tone="green" icon={CheckCheck} label="Messages delivered" value={show(totals.delivered)} detail="All messages, per WhatsApp" />
      <MetricCard tone="violet" icon={Percent} label="Delivery rate" value={totals.sent && totals.delivered !== null ? `${((totals.delivered / totals.sent) * 100).toFixed(1)}%` : "—"} detail="Delivered out of sent, per WhatsApp" />
    </div>
    {totals.asOf && <p className={ui.notice}>WhatsApp is not answering right now. These totals are the last values received on {formatDateTime(totals.asOf)}.</p>}
    {totals.sent === null && <p className={ui.notice}>WhatsApp totals could not be loaded right now. The campaign numbers below are unaffected.</p>}
  </section>;
}

const show = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US"));

export async function MetricsSection() {
  const [metrics, adjustments] = await Promise.all([getWorkspaceMetrics(), getMetricAdjustments()]);
  const categories = metrics?.categories ?? null;
  const metaNote = categories ? (metrics?.categoriesAsOf ? `Last known, per Meta (${formatDateTime(metrics.categoriesAsOf)})` : "Delivered, per Meta (12 months)") : null;

  return (
    <>
      <section aria-label="Workspace metrics" className={styles.metricGrid}>
        <MetricCard tone="indigo" icon={Users} label="Contacts" value={show(metrics?.contacts ?? null)}
          detail={metrics?.contacts == null ? "Database setup needed" : "Saved numbers"} />
        <MetricCard tone="red" icon={UserMinus} label="Opted out" value={show(metrics?.optedOut ?? null)} detail="Never messaged" />
        <MetricCard tone="coral" icon={Megaphone} label="Campaigns" value={show(metrics?.campaigns ?? null)}
          detail={metrics?.campaigns == null ? "Database setup needed" : `${metrics.activeCampaigns ?? 0} active now`} />
      </section>

      <section aria-labelledby="category-heading" className={styles.categorySection}>
        <div className={styles.sectionHead}>
          <h2 id="category-heading">Messages by category</h2>
          {metaNote && <span>{metaNote}</span>}
        </div>
        <div className={styles.categoryGrid}>
          <MetricCard tone="violet" icon={Sparkles} label="Marketing" value={show(categories ? categories.marketing : (metrics?.campaignSent == null ? null : metrics.campaignSent + adjustments.marketing))}
            detail={categories ? "Promotions and offers" : "Meta unavailable: showing campaign sends, not delivered"} />
          <MetricCard tone="teal" icon={BellRing} label="Utility" value={show(categories ? categories.utility : adjustments.utility || null)} detail="Order and account updates" />
          <MetricCard tone="gold" icon={ShieldCheck} label="Authentication" value={show(categories ? categories.authentication : adjustments.authentication || null)} detail="One-time passcodes" />
        </div>
      </section>
    </>
  );
}

export async function QualityBanner() {
  if (!metaSettingsPresent()) return null;
  let rating: string | null = null;
  try {
    rating = (await getMetaAccountHealthCached())?.phoneNumber?.qualityRating ?? null;
  } catch {
    return null;
  }
  const level = String(rating ?? "").toUpperCase();
  const status = level === "GREEN"
    ? { tone: "statusHigh", Icon: CheckCircle2, title: "Number quality: High", text: "You can proceed with your next campaign." }
    : level === "YELLOW"
      ? { tone: "statusMedium", Icon: AlertTriangle, title: "Number quality: Medium", text: "Please wait until your quality rating returns to High before sending your next campaign." }
      : level === "RED"
        ? { tone: "statusLow", Icon: AlertTriangle, title: "Number quality: Low", text: "Your quality rating is Low. Please wait until it returns to High before sending your next campaign." }
        : null;
  if (!status) return null;
  return (
    <section className={`${styles.qualityStatus} ${styles[status.tone]}`} aria-label="Quality rating status" role="status">
      <status.Icon size={20} aria-hidden="true" />
      <div><strong>{status.title}</strong><p>{status.text}</p></div>
    </section>
  );
}

export async function LastCampaignSection() {
  const admin = createStaffAdminClient();
  // Last campaign that actually went out (drafts, scheduled and canceled ones are ignored).
  const lastRowResult = admin
    ? await admin.from("whatsapp_campaigns").select("id,name,state,created_at")
        .in("state", ["running", "paused", "completed"]).order("created_at", { ascending: false }).limit(1)
    : null;
  const lastRow = lastRowResult && !lastRowResult.error ? lastRowResult.data?.[0] ?? null : null;

  const [analyticsResult, healthResult] = await Promise.allSettled([
    lastRow ? getCampaignAnalytics(lastRow.id) : Promise.resolve(null),
    metaSettingsPresent() ? getMetaAccountHealthCached() : Promise.resolve(null),
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
        const fromIso = new Date(Date.parse(last.firstAcceptedAt) - 30 * 60_000).toISOString();
        const toIso = new Date(Math.max(Date.parse(last.lastStatusAt ?? last.firstAcceptedAt), Date.parse(last.lastAcceptedAt ?? last.firstAcceptedAt)) + 60 * 60_000).toISOString();
        const billed = (await getBilledCostSnapshot(fromIso, toIso)).value;
        if (billed) price = billed.cost.toFixed(4);
      }
    } catch { /* price stays "—" */ }
  }

  const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
  const tiles: { label: string; value: string; detail: string; tone: Tone; icon: LucideIcon }[] = last ? [
    { label: "Sent", value: show(last.accepted), detail: `of ${show(last.audience)} in audience`, tone: "indigo", icon: Send },
    { label: "Delivered", value: show(last.delivered), detail: `${share(last.delivered, last.accepted)} of sent`, tone: "green", icon: CheckCheck },
    { label: "Failed", value: show(last.failed + last.rejected), detail: `${last.failed} delivery · ${last.rejected} rejected`, tone: "red", icon: AlertTriangle },
    { label: "Price", value: price, detail: "Delivered messages", tone: "ink", icon: Megaphone },
    { label: "Responses", value: show(last.repliers), detail: `${last.replies} messages`, tone: "teal", icon: Users },
    { label: "Opted out", value: show(last.optOuts), detail: `${share(last.optOuts, last.delivered)} of delivered`, tone: "gold", icon: UserMinus },
  ] : [];
  const qualityInfo = QUALITY[String(quality ?? "").toUpperCase()];

  return (
    <section className={`${ui.panel} ${styles.lastCampaignPanel}`} aria-labelledby="last-campaign-heading">
      <div className={ui.panelHeading}>
        <div className={styles.lastTitle}>
          <h2 id="last-campaign-heading">Last campaign</h2>
          {last && <p><strong>{last.campaign.name}</strong> <CampaignStateBadge state={last.campaign.state} /> <CategoryBadge category="MARKETING" /> <span>{formatDate(last.campaign.createdAt)}</span></p>}
        </div>
        {last && <div className={styles.lastActions}>
          {last.failed + last.rejected > 0 && <Link href={`/dashboard/campaigns/${last.campaign.id}?tab=failed`} className={`${ui.btn} ${ui.btnSecondary} ${ui.btnSm}`}>Manage failed messages</Link>}
          <Link href={`/dashboard/campaigns/${last.campaign.id}/analytics`} className={`${ui.btn} ${ui.btnSecondary} ${ui.btnSm}`}>Full analytics</Link>
        </div>}
      </div>
      {last ? <div className={styles.lastGrid}>
        {tiles.map((tile) => <article key={tile.label} className={`${styles.lastTile} ${styles[`tone_${tile.tone}`]}`}>
          <span className={styles.lastIcon} aria-hidden="true"><tile.icon size={16} /></span>
          <span className={styles.lastLabel}>{tile.label}</span><strong>{tile.value}</strong><small>{tile.detail}</small>
        </article>)}
        <article className={`${styles.lastTile} ${styles.tone_ink}`}>
          <span className={styles.lastIcon} aria-hidden="true"><ShieldCheck size={16} /></span>
          <span className={styles.lastLabel}>Number quality</span>
          <strong>{qualityInfo ? <span className={`${styles.quality} ${styles[qualityInfo.className]}`}><i aria-hidden="true" />{qualityInfo.label}</span> : "—"}</strong>
          <small>{qualityInfo ? "WhatsApp quality rating" : quality ? "Unknown rating" : "Not available from Meta"}</small>
        </article>
      </div> : <p className={styles.lastEmpty}>{lastRow
        ? <>Results for “{lastRow.name}” could not be loaded right now. <Link href={`/dashboard/campaigns/${lastRow.id}`}>Open campaign</Link></>
        : lastRowResult && !lastRowResult.error
          ? <>Send your first campaign to see its results here. <Link href="/dashboard/campaigns">Open campaigns</Link></>
          : "Campaign data is unavailable. Check the database setup."}</p>}
    </section>
  );
}
