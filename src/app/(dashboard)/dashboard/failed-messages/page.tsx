import type { Metadata } from "next";
import Link from "next/link";
import { Pagination, pageFrom } from "@/components/ui/pagination";
import {
  loadFailedOverview, parseCampaignFilter, parseStatusFilter, RETRY_STATUSES, type FailedRow,
} from "@/server/campaigns/retries";
import { describeDelay } from "@/server/campaigns/retry-math";
import { AutoRetryForm, ReactivateButton, ResolveAlertButton, RetryButton } from "./controls";
import styles from "../contacts/contacts.module.css";

export const metadata: Metadata = {
  title: "Failed messages | Solalyn",
  description: "Retry, review and export messages that WhatsApp could not deliver.",
};

const STATUS_LABEL: Record<string, string> = {
  eligible: "Retry eligible", pending: "Retry pending", recovered: "Recovered", exhausted: "Exhausted",
  stopped: "Needs a look", not_retryable: "Not retryable",
};
const REASON_LABEL: Record<string, string> = {
  retry_exhausted: "3 retries failed", repeated_131049: "Repeated 131049 across campaigns",
  undeliverable_131026: "Undeliverable (131026)", cooldown_131056: "Cooling down after 131056",
};

function when(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function badgeClass(status: FailedRow["retryStatus"]) {
  if (status === "recovered") return `${styles.badge} ${styles.badgeOk}`;
  if (status === "exhausted" || status === "stopped") return `${styles.badge} ${styles.badgeBad}`;
  if (status === "pending" || status === "eligible") return `${styles.badge} ${styles.badgeWarn}`;
  return styles.badge;
}

export default async function FailedMessagesPage({ searchParams }: {
  searchParams: Promise<{ campaign?: string | string[]; status?: string | string[]; page?: string | string[] }>;
}) {
  const params = await searchParams;
  const campaignId = parseCampaignFilter(params.campaign);
  const status = parseStatusFilter(params.status);
  const page = pageFrom(params.page);
  const PAGE_SIZE = 25;
  const data = await loadFailedOverview({ campaignId, status, page, pageSize: PAGE_SIZE });
  const { summary } = data;
  const selected = data.campaigns.find((c) => c.id === campaignId) ?? null;
  const exportHref = `/api/failed-messages/export${campaignId ? `?campaign=${campaignId}` : ""}`;
  const query = (extra: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const merged = { campaign: campaignId, status, ...extra };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const text = next.toString();
    return text ? `?${text}` : "";
  };

  return (
    <div className={styles.content}>
      <div className={styles.pageHead}>
        <h1>Failed messages{data.ready && <small>{summary.total}</small>}</h1>
        <div className={styles.actions}>
          <RetryButton campaignId={campaignId} disabled={!data.ready || summary.eligibleReady === 0} />
          <a className={styles.secondaryButton} href={exportHref}>Export Failed Contacts</a>
        </div>
      </div>

      {!data.ready && <section className={styles.notice}><strong>Database setup needed</strong>
        <p>Run <code>drizzle/0025_contact_delivery_status.sql</code> and <code>drizzle/0026_failed_message_retries.sql</code> in Supabase to enable this page.</p></section>}

      {data.alerts.map((alert) => <section key={alert.id} className={styles.alertBanner} role="alert">
        <strong>WhatsApp limited your business number ({alert.code})</strong>
        <p>{alert.title ?? "Meta reported a spam-rate limit."} Campaigns on this number were paused and retries are on hold. Do not resume until the quality rating recovers in WhatsApp Manager.</p>
        <ResolveAlertButton alertId={alert.id} />
      </section>)}

      <section className={styles.panel} aria-labelledby="summary-heading">
        <div className={styles.panelHeading}><h2 id="summary-heading">{selected ? selected.name : "All campaigns"}</h2>
          <form method="get" className={styles.filterRow}>
            <label className={styles.field}><span>Campaign</span>
              <select name="campaign" defaultValue={campaignId ?? ""}>
                <option value="">All campaigns</option>
                {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <button className={styles.secondaryButton} type="submit">Filter</button>
          </form>
        </div>
        <div className={styles.stats}>
          <div className={`${styles.stat} ${styles.statDanger}`}><strong>{summary.total}</strong><span>Total failures</span></div>
          <div className={styles.stat}><strong>{summary.eligible}</strong><span>Retry eligible</span></div>
          <div className={`${styles.stat} ${styles.statSkip}`}><strong>{summary.pending}</strong><span>Retry pending</span></div>
          <div className={`${styles.stat} ${styles.statOk}`}><strong>{summary.recovered}</strong><span>Recovered</span></div>
          <div className={`${styles.stat} ${styles.statDanger}`}><strong>{summary.exhausted}</strong><span>Exhausted</span></div>
        </div>
        {summary.eligible > summary.eligibleReady && <p className={styles.muted}>
          {summary.eligibleReady} can be retried now. The other {summary.eligible - summary.eligibleReady} are still inside the waiting time, because WhatsApp limits repeat marketing messages (code 131049) and retrying early makes it worse.</p>}
        {summary.stopped > 0 && <p className={styles.muted}>{summary.stopped} retry attempts ended without a clear answer and are not repeated automatically. Check them below.</p>}
      </section>

      <section className={styles.panel} aria-labelledby="codes-heading">
        <div className={styles.panelHeading}><h2 id="codes-heading">Error codes</h2></div>
        {summary.byCode.length ? <div className={styles.tableWrap}><table>
          <thead><tr><th>Code</th><th>What it means</th><th>Messages</th></tr></thead>
          <tbody>{summary.byCode.map((c) => <tr key={c.code}><td>{c.code}</td><td>{c.title ?? "—"}</td><td>{c.count}</td></tr>)}</tbody>
        </table></div> : <p className={styles.empty}>No failed messages yet.</p>}
      </section>

      <section className={styles.panel} aria-labelledby="auto-heading">
        <div className={styles.panelHeading}><h2 id="auto-heading">Auto retry</h2>
          <span>{selected ? (selected.autoRetry ? "On for this campaign" : "Off for this campaign") : "Pick a campaign"}</span></div>
        <p className={styles.muted}>Only code 131049 is retried, at most 3 times, never right away, and only for people who are still allowed to be messaged. Auto retry is off unless you turn it on for a campaign.
          {selected && selected.autoRetry && <> Current waits: {selected.delays.map(describeDelay).join(", ")}.</>}</p>
        {selected ? <AutoRetryForm campaignId={selected.id} enabled={selected.autoRetry} delays={selected.delays} />
          : <p className={styles.empty}>Choose a campaign above to change its auto retry.</p>}
      </section>

      <section className={styles.panel} aria-labelledby="list-heading">
        <div className={styles.panelHeading}><h2 id="list-heading">Failed messages</h2>
          <div className={styles.actions}>
            <Link className={styles.chip} href={`/dashboard/failed-messages${query({ status: null, page: null })}`} aria-current={!status ? "true" : undefined}>All</Link>
            {RETRY_STATUSES.map((s) => <Link key={s} className={styles.chip} aria-current={status === s ? "true" : undefined}
              href={`/dashboard/failed-messages${query({ status: s, page: null })}`}>{STATUS_LABEL[s]}</Link>)}
          </div></div>
        {data.rows.length ? <div className={styles.tableWrap}><table>
          <thead><tr><th>Number</th><th>Campaign</th><th>Error</th><th>Failed</th><th>Retries</th><th>Status</th><th>Next retry</th></tr></thead>
          <tbody>{data.rows.map((row) => <tr key={row.failureId}>
            <td>{row.phone}</td><td>{row.campaignName}</td>
            <td>{row.errorCode}{row.errorTitle ? <small> · {row.errorTitle}</small> : null}</td>
            <td>{when(row.failedAt)}</td><td>{row.attemptsMade} of 3</td>
            <td><span className={badgeClass(row.retryStatus)}>{STATUS_LABEL[row.retryStatus]}</span></td>
            <td>{row.retryStatus === "eligible" || row.retryStatus === "pending" ? when(row.retryReadyAt) : "—"}</td>
          </tr>)}</tbody>
        </table></div> : <p className={styles.empty}>{data.ready ? "Nothing here." : "Appears after setup."}</p>}
        {data.ready && <Pagination page={page} total={data.rowCount} pageSize={PAGE_SIZE} param="page" path="/dashboard/failed-messages" query={{ campaign: campaignId ?? undefined, status: status ?? undefined }} label="Failed message pages" />}
      </section>

      <section className={styles.panel} aria-labelledby="review-heading">
        <div className={styles.panelHeading}><h2 id="review-heading">Manual review</h2><span>{data.reviewCount} Do Not Send</span></div>
        <p className={styles.muted}>These numbers are not messaged and are not opted out. After checking one, reactivate it to allow campaigns again.</p>
        {data.review.length ? <div className={styles.tableWrap}><table>
          <thead><tr><th>Number</th><th>Why</th><th>Review after</th><th /></tr></thead>
          <tbody>{data.review.map((r) => <tr key={r.phone}>
            <td>{r.phone}</td><td>{REASON_LABEL[r.reason ?? ""] ?? r.reason ?? "—"}</td>
            <td>{when(r.reviewDueAt ?? r.holdUntil)}</td><td><ReactivateButton phone={r.phone} /></td>
          </tr>)}</tbody>
        </table></div> : <p className={styles.empty}>No numbers waiting for review.</p>}
        {data.reviewCount > data.review.length && <p className={styles.muted}>Showing the first {data.review.length}. Export for the full list.</p>}
      </section>
    </div>
  );
}
