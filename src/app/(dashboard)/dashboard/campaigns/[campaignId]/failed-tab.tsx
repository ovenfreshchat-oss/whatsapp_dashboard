import Link from "next/link";
import { Pagination } from "@/components/ui/pagination";
import {
  loadCampaignFailures, loadOpenSenderAlerts, previewFailedContacts, RETRY_STATUSES, type FailedRowDetail,
} from "@/server/campaigns/retries";
import type { RetryStatusFilter } from "@/server/campaigns/retries";
import { describeDelay } from "@/server/campaigns/retry-math";
import { describeErrorCode, describeExclusion, explainRetry } from "@/server/campaigns/retry-explain";
import { AutoRetryForm, CreateFromSelected, ReactivateButton, ResolveAlertButton, RetryButton } from "./failed-controls";
import styles from "../../contacts/contacts.module.css";

const PAGE_SIZE = 25;
const STATUS_LABEL: Record<string, string> = {
  eligible: "Retry eligible", pending: "Retry pending", recovered: "Recovered", exhausted: "Retry exhausted",
  stopped: "Needs a look", not_retryable: "Not retryable",
};

function when(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function badgeClass(status: FailedRowDetail["retryStatus"]) {
  if (status === "recovered") return `${styles.badge} ${styles.badgeOk}`;
  if (status === "exhausted" || status === "stopped") return `${styles.badge} ${styles.badgeBad}`;
  if (status === "pending" || status === "eligible") return `${styles.badge} ${styles.badgeWarn}`;
  return styles.badge;
}

const ATTEMPT_STATE: Record<string, string> = {
  pending: "Waiting to send", in_flight: "Sending", accepted: "Sent", rejected: "Rejected by WhatsApp",
  uncertain: "Outcome unclear", skipped: "Skipped", canceled: "Canceled",
};

/** The Failed Messages tab of one campaign: summary, retries, history, export and "new campaign from failed contacts". */
export async function FailedMessagesTab({ campaignId, status, page }: {
  campaignId: string; status: RetryStatusFilter | null; page: number;
}) {
  const [data, alerts, allPreview] = await Promise.all([
    loadCampaignFailures({ campaignId, status, page, pageSize: PAGE_SIZE }),
    loadOpenSenderAlerts(),
    previewFailedContacts(campaignId, null),
  ]);
  const { summary, campaign } = data;
  if (!data.ready || !campaign) {
    return <section className={styles.notice}><strong>Database setup needed</strong>
      <p>Run <code>drizzle/0025</code>, <code>0026</code>, <code>0027</code> and <code>0028</code> in Supabase to enable failed message management.</p></section>;
  }
  const base = `/dashboard/campaigns/${campaignId}`;
  const tabQuery = (extra: Record<string, string | null>) => {
    const next = new URLSearchParams({ tab: "failed" });
    const merged = { status, ...extra };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    return `?${next.toString()}`;
  };
  const formId = "failed-contacts-form";

  return <div className={styles.stack}>
    {alerts.map((alert) => <section key={alert.id} className={styles.alertBanner} role="alert">
      <strong>WhatsApp limited your business number ({alert.code})</strong>
      <p>{alert.title ?? "Meta reported a spam-rate limit."} Campaigns on this number were paused and retries are on hold. Do not resume until the quality rating recovers in WhatsApp Manager.</p>
      <ResolveAlertButton alertId={alert.id} />
    </section>)}

    <section className={styles.panel} aria-labelledby="failed-summary-heading">
      <div className={styles.panelHeading}><h2 id="failed-summary-heading">Failed messages</h2>
        <div className={styles.actions}>
          <RetryButton campaignId={campaign.id} campaignName={campaign.name} ready={summary.eligibleReady} waiting={summary.eligible - summary.eligibleReady} />
          <a className={styles.secondaryButton} href={`/api/failed-messages/export?campaign=${campaign.id}`}>Export Failed Contacts</a>
        </div>
      </div>
      <div className={styles.stats}>
        <div className={`${styles.stat} ${styles.statDanger}`}><strong>{summary.total}</strong><span>Total failed</span></div>
        <div className={styles.stat}><strong>{summary.eligible}</strong><span>Retry eligible</span></div>
        <div className={`${styles.stat} ${styles.statSkip}`}><strong>{summary.pending}</strong><span>Retry pending</span></div>
        <div className={`${styles.stat} ${styles.statOk}`}><strong>{summary.recovered}</strong><span>Recovered</span></div>
        <div className={`${styles.stat} ${styles.statDanger}`}><strong>{summary.exhausted}</strong><span>Retry exhausted</span></div>
      </div>
      {summary.eligible > summary.eligibleReady && <p className={styles.muted}>
        {summary.eligibleReady} can be retried now. The other {summary.eligible - summary.eligibleReady} are still inside the waiting time, because WhatsApp limits repeat marketing messages (code 131049) and retrying early makes it worse.</p>}
      {summary.stopped > 0 && <p className={styles.muted}>{summary.stopped} retry attempts ended without a clear answer and are not repeated automatically.</p>}
    </section>

    <section className={styles.panel} aria-labelledby="codes-heading">
      <div className={styles.panelHeading}><h2 id="codes-heading">Error codes</h2></div>
      {summary.byCode.length ? <div className={styles.tableWrap}><table>
        <thead><tr><th>Code</th><th>What it means</th><th>Messages</th></tr></thead>
        <tbody>{summary.byCode.map((c) => <tr key={c.code}><td>{c.code}</td><td>{describeErrorCode(c.code, c.title)}</td><td>{c.count}</td></tr>)}</tbody>
      </table></div> : <p className={styles.empty}>No failed messages in this campaign.</p>}
    </section>

    <section className={`${styles.panel} ${styles.autoRetryPanel}`} aria-labelledby="auto-heading">
      <div className={styles.panelHeading}><h2 id="auto-heading">Auto retry</h2><span>{campaign.autoRetry ? "On" : "Off"}</span></div>
      <p className={styles.muted}>Some messages fail because WhatsApp limits how many marketing messages one person can get (error 131049). Auto retry sends those messages again later, so you do not have to.
        It never retries straight away. It waits the number of hours you set below, and tries up to 3 times. It only retries people who can still be messaged.
        If a message still fails after 3 retries, that number is paused for 30 days (shown as Do Not Send) so you can check it. It is never moved to the Global Opt Out list.
        {campaign.autoRetry && <> Current waiting times: {campaign.delays.map(describeDelay).join(", ")}.</>}</p>
      <AutoRetryForm campaignId={campaign.id} enabled={campaign.autoRetry} delays={campaign.delays} />
    </section>

    <section className={styles.panel} aria-labelledby="list-heading">
      <div className={styles.panelHeading}><h2 id="list-heading">Failed contacts</h2>
        <div className={styles.actions}>
          <Link className={styles.chip} href={`${base}${tabQuery({ status: null })}`} aria-current={!status ? "true" : undefined}>All</Link>
          {RETRY_STATUSES.map((s) => <Link key={s} className={styles.chip} aria-current={status === s ? "true" : undefined}
            href={`${base}${tabQuery({ status: s })}`}>{STATUS_LABEL[s]}</Link>)}
        </div></div>

      {data.rows.length ? <form id={formId}><div className={styles.tableWrap}><table>
        <thead><tr><th>Select</th><th>Contact</th><th>Error</th><th>Failed</th><th>Retries</th><th>Retry status</th><th>Next retry</th><th>Why / history</th></tr></thead>
        <tbody>{data.rows.map((row) => {
          const why = explainRetry(row);
          return <tr key={row.failureId}>
            <td>{row.newCampaign.eligible
              ? <input type="checkbox" name="failureId" value={row.failureId} aria-label={`Select ${row.phone}`} />
              : <small title={describeExclusion(row.newCampaign.reason)}>{describeExclusion(row.newCampaign.reason)}{row.newCampaign.readyAt ? ` · from ${when(row.newCampaign.readyAt)}` : ""}</small>}</td>
            <td>{row.name ?? "—"}<br /><small>{row.phone}</small></td>
            <td>{row.errorCode}</td>
            <td>{when(row.failedAt)}</td><td>{row.attemptsMade} of 3</td>
            <td><span className={badgeClass(row.retryStatus)}>{STATUS_LABEL[row.retryStatus]}</span></td>
            <td>{row.retryStatus === "eligible" || row.retryStatus === "pending" ? when(row.retryReadyAt) : "—"}</td>
            <td>
              {why && <small>{why}</small>}
              {row.contactStatus === "do_not_send" && <><br /><ReactivateButton phone={row.phone} campaignId={campaign.id} /></>}
              <details><summary><small>Retry history ({row.history.length})</small></summary>
                <ol>
                  <li><small>Original message failed {when(row.failedAt)} ({row.errorCode})</small></li>
                  {row.history.map((h) => <li key={h.attempt}><small>
                    Retry {h.attempt} ({h.trigger}): {ATTEMPT_STATE[h.state] ?? h.state}
                    {h.deliveryStatus ? `, ${h.deliveryStatus}` : ""}{h.errorCode ? ` (${h.errorCode})` : ""} · {when(h.sentAt ?? h.scheduledFor)}
                  </small></li>)}
                </ol>
              </details>
            </td>
          </tr>;
        })}</tbody>
      </table></div></form> : <p className={styles.empty}>Nothing here.</p>}

      <Pagination page={page} total={data.rowCount} pageSize={PAGE_SIZE} param="fp" path={base}
        query={{ tab: "failed", status: status ?? undefined }} label="Failed message pages" />
    </section>

    <section className={styles.panel} aria-labelledby="new-heading">
      <div className={styles.panelHeading}><h2 id="new-heading">Create a new campaign from failed contacts</h2>
        <span>{allPreview ? `${allPreview.eligible} eligible · ${allPreview.excluded} excluded` : ""}</span></div>
      <p className={styles.muted}>Tick eligible contacts above, then compose a new message with an approved marketing template. Contacts on a waiting time, Do Not Send hold, suppression or Global Opt Out cannot be selected. This does not reset any failure counts, and the original campaign keeps its history.</p>
      <CreateFromSelected campaignId={campaign.id} formId={formId} eligibleTotal={allPreview?.eligible ?? 0} />
    </section>
  </div>;
}
