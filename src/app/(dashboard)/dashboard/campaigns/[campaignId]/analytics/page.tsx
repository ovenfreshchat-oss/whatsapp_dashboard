import type { Metadata } from "next";
import { BackLink } from "@/components/ui/back-link";
import { getCampaignAnalytics, getMetaTemplateStats, type CampaignAnalytics } from "@/server/campaigns/analytics";
import { AutoRefresh } from "../../auto-refresh";
import { estimateCost, getMetaBilledCost, getRateCard, listCampaignPhones } from "@/server/campaigns/pricing";
import { RefreshButton } from "@/components/ui/refresh-button";
import styles from "../../campaigns.module.css";

export const metadata: Metadata = { title: "Campaign analytics | Solalyn" };
export const dynamic = "force-dynamic";

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");
const width = (part: number, whole: number) => `${whole > 0 ? Math.min(100, (part / whole) * 100) : 0}%`;
const when = (value: string | null) => (value ? `${value.slice(0, 16).replace("T", " ")} UTC` : "—");
function duration(seconds: number | null) {
  if (seconds === null || seconds < 0) return "—";
  if (seconds < 90) return `${Math.round(seconds)} sec`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}

function warnings(a: CampaignAnalytics): string[] {
  const out: string[] = [];
  if (a.accepted > 0 && a.noStatus === a.accepted) {
    out.push("Meta accepted these messages but no delivery status has reached the dashboard for any of them. Delivered and read are unknown, not zero. Check the webhook (Vercel logs for /api/webhooks/meta/whatsapp) and compare with the Meta panel below.");
  } else if (a.noStatus > 0) {
    out.push(`${a.noStatus} accepted messages have no status yet. Statuses can lag by minutes to hours.`);
  }
  if (a.uncertain > 0) out.push(`${a.uncertain} sends have an uncertain outcome and were not retried.`);
  if (a.conflicts > 0) out.push(`${a.conflicts} recipients received conflicting statuses.`);
  return out;
}

export default async function CampaignAnalyticsPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  let a: CampaignAnalytics | null = null;
  let loadError = "";
  try { a = await getCampaignAnalytics(campaignId); } catch (error) {
    loadError = error instanceof Error ? error.message : "Analytics could not be loaded.";
  }
  const meta = a ? await getMetaTemplateStats(a) : null;
  const card = getRateCard();
  const estimate = a && card
    ? estimateCost(await listCampaignPhones(a.campaign.id, { deliveryStatuses: ["delivered", "read"] }).catch(() => []), card)
    : null;
  const billed = a?.firstAcceptedAt
    ? await getMetaBilledCost(
        new Date(Date.parse(a.firstAcceptedAt) - 30 * 60_000).toISOString(),
        new Date(Math.max(Date.parse(a.lastStatusAt ?? a.firstAcceptedAt), Date.parse(a.lastAcceptedAt ?? a.firstAcceptedAt)) + 60 * 60_000).toISOString())
    : null;
  const money = (value: number, currency: string) => `${currency} ${value.toFixed(value < 1 ? 4 : 2)}`;
  const peak = a ? Math.max(1, ...a.timeline.map((t) => t.accepted)) : 1;

  return <>
    <div className={styles.content}>
      <BackLink href={`/dashboard/campaigns/${campaignId}`}>Back to campaign</BackLink>
      {!a ? <section className={styles.notice}><strong>Analytics unavailable</strong><p>{loadError}</p></section> : <>
        <div className={styles.intro}>
          <div>
            <span className={styles.eyebrow}>ANALYTICS / {a.campaign.state.toUpperCase()}</span>
            <h1>{a.campaign.name}<span>.</span></h1>
            <p>Template {a.campaign.templateName} · first message {when(a.firstAcceptedAt)} · last status {when(a.lastStatusAt)}</p>
          </div>
          <div className={styles.buttonRow}>
            {a.campaign.state !== "draft" && <AutoRefresh intervalMs={a.campaign.state === "running" || a.campaign.state === "scheduled" ? 5000 : 20000} />}
            <RefreshButton className={styles.refreshLink} />
            <a href={`/api/campaigns/${campaignId}/export`} className={styles.refreshLink}>Download CSV ↓</a>
          </div>
        </div>

        {warnings(a).map((text) => <section key={text} className={styles.notice} role="status"><strong>Check this</strong><p>{text}</p></section>)}

        <section className={styles.kpiGrid} aria-label="Key numbers">
          <article className={styles.kpi}><span>Audience</span><strong>{a.audience}</strong><small>{a.accepted} accepted by Meta</small></article>
          <article className={styles.kpi}><span>Delivered</span><strong>{pct(a.delivered, a.accepted)}</strong><small>{a.delivered} of {a.accepted}</small></article>
          <article className={styles.kpi}><span>Read</span><strong>{pct(a.read, a.delivered)}</strong><small>{a.read} of {a.delivered} delivered</small></article>
          <article className={styles.kpi}><span>Replies</span><strong>{a.repliers}</strong><small>{a.replies} messages · {pct(a.repliers, a.delivered)} of delivered</small></article>
          <article className={styles.kpi}><span>Opt-outs</span><strong>{a.optOuts}</strong><small>{pct(a.optOuts, a.delivered)} of delivered</small></article>
          <article className={styles.kpi}><span>Failed</span><strong>{a.failed + a.rejected}</strong><small>{a.failed} delivery · {a.rejected} rejected</small></article>
        </section>

        <div className={styles.twoColumn}>
          <section className={styles.panel} aria-labelledby="funnel-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>FUNNEL</span><h2 id="funnel-heading">From audience to read</h2></div></div>
            <div className={styles.funnel}>
              {([
                ["Audience", a.audience], ["Accepted by Meta", a.accepted], ["Sent", a.sent],
                ["Delivered", a.delivered], ["Read", a.read],
              ] as const).map(([label, value]) => <div key={label} className={styles.funnelRow}>
                <div className={styles.funnelLabel}><span>{label}</span><strong>{value} <small>{pct(value, a.audience)}</small></strong></div>
                <div className={styles.bar}><div style={{ width: width(value, a.audience) }} /></div>
              </div>)}
            </div>
            <dl className={styles.countList}>
              <div><dt>Not sent: opted out or ineligible</dt><dd>{a.suppressed}</dd></div>
              <div><dt>Not sent: canceled</dt><dd>{a.canceled}</dd></div>
              <div><dt>Still waiting to send</dt><dd>{a.pending}</dd></div>
              <div><dt>Accepted, no status yet</dt><dd>{a.noStatus}</dd></div>
              <div><dt>Median time to delivered</dt><dd>{duration(a.medianDeliveredSeconds)}</dd></div>
              <div><dt>Median time to read</dt><dd>{duration(a.medianReadSeconds)}</dd></div>
            </dl>
            <p className={styles.helper}>“Sent” and “Delivered” include messages that moved further, so each step contains the next. Replies and opt-outs count contacts of this campaign who wrote after the first message went out, so they can include replies to other campaigns.</p>
          </section>

          <section className={styles.panel} aria-labelledby="meta-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>CROSS-CHECK</span><h2 id="meta-heading">What Meta reports</h2></div><span>{meta ? `${meta.from} → ${meta.to}` : "Unavailable"}</span></div>
            {meta ? <>
              <dl className={styles.countList}>
                <div><dt>Sent</dt><dd>{meta.sent}</dd></div>
                <div><dt>Delivered</dt><dd>{meta.delivered}</dd></div>
                <div><dt>Read</dt><dd>{meta.read}</dd></div>
              </dl>
              <p className={styles.helper}>Meta counts every send of template “{a.campaign.templateName}” in those days, not only this campaign, and its numbers can lag a day. If Meta shows delivered messages while the dashboard has none, the webhook is not reaching the database.</p>
            </> : <p className={styles.empty}>Meta’s template analytics could not be loaded (not available yet, or the access token lacks permission). The dashboard numbers above are unaffected.</p>}
            <h3 className={styles.subheading}>Failures</h3>
            {a.failureReasons.length || a.rejectionReasons.length ? <dl className={styles.countList}>
              {a.failureReasons.map((r) => <div key={`${r.code}${r.title}`}><dt>{r.title} (code {r.code})</dt><dd>{r.total}</dd></div>)}
              {a.rejectionReasons.map((r) => <div key={r.reason}><dt>Rejected: {r.reason}</dt><dd>{r.total}</dd></div>)}
            </dl> : <p className={styles.helper}>No failures recorded.</p>}
          </section>
        </div>

        <section className={styles.panel} aria-labelledby="cost-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>COST</span><h2 id="cost-heading">Campaign cost</h2></div></div>
          <p className={styles.price}>{estimate
            ? money(estimate.total, estimate.currency)
            : billed ? billed.cost.toFixed(4) : "—"}</p>
          <p className={styles.helper}>{a.delivered} delivered {a.delivered === 1 ? "message" : "messages"}</p>
        </section>

        <section className={styles.panel} aria-labelledby="timeline-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>TIMELINE</span><h2 id="timeline-heading">Messages sent per hour (UTC)</h2></div></div>
          {a.timeline.length ? <div className={styles.timeline}>
            {a.timeline.map((t) => <div key={t.hour} className={styles.timelineRow}>
              <time dateTime={t.hour}>{t.hour.slice(5, 13).replace("T", " ")}h</time>
              <div className={styles.bar}><div style={{ width: width(t.accepted, peak) }} /></div>
              <span>{t.accepted} sent · {t.delivered} delivered · {t.read} read</span>
            </div>)}
          </div> : <p className={styles.empty}>Nothing has been sent yet.</p>}
        </section>
      </>}
    </div>
  </>;
}
