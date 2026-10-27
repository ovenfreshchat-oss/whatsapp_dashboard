import type { Metadata } from "next";
import Link from "next/link";
import { BackLink } from "@/components/ui/back-link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { AUDIT_PAGE_SIZE, getCampaignDetail, listExcludedRecipients, RECIPIENTS_PAGE_SIZE } from "@/server/campaigns/admin";
import { Pagination, pageFrom } from "@/components/ui/pagination";
import { getCampaignWorkerReadiness } from "@/server/campaigns/worker";
import { parseTemplateBodyParameters } from "@/server/meta/templates";
import { CampaignControls } from "../campaign-controls";
import { DeleteDraftButton } from "../delete-draft";
import { ExcludeNumbers } from "../exclude-numbers";
import { AutoRefresh } from "../auto-refresh";
import { RefreshButton } from "@/components/ui/refresh-button";
import styles from "../campaigns.module.css";

export const metadata: Metadata = { title: "Campaign review | The Oven Fresh" };

type PageProps = {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ tab?: string | string[]; rp?: string | string[]; ap?: string | string[] }>;
};

const TABS = [["overview", "Overview"], ["message", "Message"], ["audience", "Audience"], ["history", "History"]] as const;
type Tab = (typeof TABS)[number][0];

function dateLabel(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const outcomeKeys = [
  ["pending", "Pending"], ["in_flight", "In flight"], ["accepted", "Accepted by Meta"],
  ["rejected", "Rejected"], ["uncertain", "Needs reconciliation"],
  ["suppressed", "Suppressed"], ["canceled", "Canceled"],
] as const;
/** Each step includes the later ones: a read message was also sent and delivered. */
function deliverySteps(counts: { sent: number; delivered: number; read: number; failed: number; delivery_conflict: number }) {
  return [
    ["Sent", counts.sent + counts.delivered + counts.read],
    ["Delivered", counts.delivered + counts.read],
    ["Read", counts.read],
    ["Failed", counts.failed],
    ["Status conflict", counts.delivery_conflict],
  ] as const;
}

function bodyReview(body: string, values: string[]) {
  try {
    const { keys } = parseTemplateBodyParameters(body);
    const replacements = new Map(keys.map((key, index) => [key, values[index] ?? ""]));
    return {
      keys,
      rendered: body.replace(/\{\{\s*([^{}]*?)\s*\}\}/g,
        (_match, key: string) => replacements.get(key) ?? ""),
    };
  } catch {
    return { keys: values.map((_, index) => String(index + 1)), rendered: "Preview unavailable for this template." };
  }
}

export default async function CampaignDetailPage({ params, searchParams }: PageProps) {
  const { campaignId } = await params;
  const query = await searchParams;
  const recipientPage = pageFrom(query.rp);
  const auditPage = pageFrom(query.ap);
  const detailResult = await Promise.allSettled([getCampaignDetail(campaignId, { recipientPage, auditPage })]);
  const campaign = detailResult[0].status === "fulfilled" ? detailResult[0].value : null;
  const readiness = getCampaignWorkerReadiness();
  const requestedTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const isDraft = campaign?.state === "draft";
  const visibleTabs = TABS.filter(([key]) => !(isDraft && key === "overview"));
  const tab: Tab = visibleTabs.some(([key]) => key === requestedTab)
    ? (requestedTab as Tab) : (isDraft ? "message" : "overview");
  const tabHref = (key: Tab) => `/dashboard/campaigns/${campaignId}?tab=${key}`;
  const excluded = campaign?.state === "draft" ? await listExcludedRecipients(campaignId).catch(() => []) : [];
  const review = campaign ? bodyReview(campaign.templateBody, campaign.bodyParameters) : null;
  const header = campaign?.templateComponents.find((part) => part.type === "HEADER");
  const footer = campaign?.templateComponents.find((part) => part.type === "FOOTER");
  const buttons = campaign?.templateComponents.find((part) => part.type === "BUTTONS")?.buttons ?? [];

  return <DashboardShell label="Campaign review" showMetaSetup>
    <div className={styles.content}>
      <BackLink href="/dashboard/campaigns">All campaigns</BackLink>
      {campaign ? <>
        <div className={styles.intro}>
          <div><span className={styles.eyebrow}>CAMPAIGN / {campaign.state.toUpperCase()}</span><h1>{campaign.name}<span>.</span></h1><p>{isDraft ? "Check the message and audience, then send or schedule." : "Progress updates on its own while sending."}</p></div>
          <div className={styles.buttonRow}>
            {isDraft && <DeleteDraftButton id={campaign.id} name={campaign.name} redirectTo="/dashboard/campaigns" label />}
            {(campaign.state === "scheduled" || campaign.state === "running") && <AutoRefresh intervalMs={5000} />}
            {campaign.state !== "draft" && <Link href={`/dashboard/campaigns/${campaign.id}/analytics`} className={styles.refreshLink}>Analytics →</Link>}
            <RefreshButton className={styles.refreshLink} />
          </div>
        </div>
        {campaign.state === "draft" && <section className={`${styles.panel} ${styles.readyPanel}`} aria-labelledby="ready-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>LAST STEP</span><h2 id="ready-heading">Send or schedule</h2></div><span className={styles.statePill}>draft</span></div>
          <div className={styles.readySummary}>
            <div><strong>{campaign.audienceCount}</strong><small>recipients</small></div>
            <div><strong>{campaign.templateName}</strong><small>{campaign.templateLanguage}</small></div>
          </div>
          <div className={styles.renderedPreview}><strong>Message preview</strong><p>{review?.rendered}</p></div>
          <ExcludeNumbers campaignId={campaign.id} excluded={excluded} />
          <CampaignControls id={campaign.id} state={campaign.state} audienceCount={campaign.audienceCount} audienceSourceLabel={campaign.audienceSourceLabel} reviewSha256={campaign.reviewSha256} />
          {!readiness.enabled && <div className={styles.formNote}><strong>Worker readiness</strong><p>{readiness.reason}</p></div>}
        </section>}
        {!isDraft && <section className={styles.summaryStrip} aria-label="Campaign summary">
          <div><span>Audience</span><strong>{campaign.audienceCount}</strong><small>{campaign.audienceSource === "import_batch" ? "Selected import" : "All eligible"}</small></div>
          <div><span>Template</span><strong className={styles.stripText}>{campaign.templateName}</strong><small>{campaign.templateLanguage}</small></div>
          <div><span>Scheduled for</span><strong className={styles.stripText}>{dateLabel(campaign.scheduledFor)}</strong><small>Created {dateLabel(campaign.createdAt)}</small></div>
        </section>}

        {(campaign.state === "scheduled" || campaign.state === "running" || campaign.state === "paused") && <section className={`${styles.panel} ${styles.actionPanel}`} aria-label="Campaign actions">
          <CampaignControls id={campaign.id} state={campaign.state} audienceCount={campaign.audienceCount} audienceSourceLabel={campaign.audienceSourceLabel} reviewSha256={campaign.reviewSha256} />
        </section>}

        <nav className={styles.tabs} aria-label="Campaign sections">
          {visibleTabs.map(([key, label]) => <Link key={key} href={tabHref(key)} scroll={false}
            className={key === tab ? styles.tabOn : ""} aria-current={key === tab ? "page" : undefined}>{label}</Link>)}
        </nav>

        {tab === "overview" && <>
          <div className={styles.twoColumn}>
            <section className={styles.panel} aria-labelledby="counts-heading">
              <div className={styles.panelHeading}><div><h2 id="counts-heading">Sending progress</h2></div><span>{campaign.audienceCount} total</span></div>
              <dl className={styles.countList}>{outcomeKeys.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{campaign.counts[key]}</dd></div>)}</dl>
              <p className={styles.helper}>“Needs reconciliation” means the API outcome is uncertain. Those recipients are parked and not retried automatically.</p>
            </section>
            <section className={styles.panel} aria-labelledby="delivery-heading">
              <div className={styles.panelHeading}><div><h2 id="delivery-heading">Delivery status</h2></div></div>
              <dl className={styles.countList}>{deliverySteps(campaign.counts).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
              <p className={styles.helper}>Meta acceptance is separate from delivery. Webhook events update these counts when available.</p>
            </section>
          </div>
          {!readiness.enabled && <section className={styles.notice}><strong>Worker readiness</strong><p>{readiness.reason}</p></section>}
        </>}

        {tab === "message" && <section className={styles.panel} aria-labelledby="message-review-heading">
          <div className={styles.panelHeading}><div><h2 id="message-review-heading">Message to send</h2></div><span>{campaign.templateLanguage}</span></div>
          <div className={styles.messageGrid}>
            <div>
              {header && <div className={styles.componentReview}>
                <strong>Header {header.format ? `(${header.format})` : ""}</strong>
                {header.format === "IMAGE" ? (
                  <div>
                    {campaign.headerMediaUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={campaign.headerMediaUrl} alt="Header Preview" className={styles.headerImagePreview} />
                      </>
                    ) : (
                      <p>No header image provided</p>
                    )}
                  </div>
                ) : (
                  <p>{header.text || "No header text"}</p>
                )}
              </div>}
              <div className={styles.renderedPreview}><strong>Rendered message</strong><p>{review?.rendered}</p></div>
              {footer && <div className={styles.componentReview}><strong>Footer</strong><p>{footer.text || "No footer text"}</p></div>}
              {buttons.length > 0 && <div className={styles.componentReview}>
                <strong>Buttons</strong>
                <ul>{buttons.map((button, index) => <li key={index}>
                  {button.text || button.type || "Button"}{button.url ? ` · ${button.url}` : ""}{button.phoneNumber ? ` · ${button.phoneNumber}` : ""}
                </li>)}</ul>
              </div>}
            </div>
            <div>
              <p className={styles.helper}>Stored approved template body</p>
              <div className={styles.templatePreview}><p>{campaign.templateBody}</p></div>
              {campaign.bodyParameters.length ? <dl className={styles.parameterList}>
                {campaign.bodyParameters.map((value, index) => <div key={index}><dt>{`{{${review?.keys[index] ?? index + 1}}}`}</dt><dd>{value}</dd></div>)}
              </dl> : <p className={styles.helper}>This body has no variables.</p>}
              <p className={styles.helper}>All recipients receive the same values.</p>
            </div>
          </div>
        </section>}

        {tab === "audience" && <section className={styles.panel} aria-labelledby="audience-review-heading">
          <div className={styles.panelHeading}><div><h2 id="audience-review-heading">Frozen audience</h2></div><span>{campaign.audienceCount} to send{campaign.recipientTotal > campaign.audienceCount ? ` · ${campaign.recipientTotal - campaign.audienceCount} skipped` : ""}</span></div>
          <p className={styles.helper}>Source: {campaign.audienceSourceLabel}</p>
          {campaign.recipientPreview.length ? <div className={styles.recipientListFlat}>
            {campaign.recipientPreview.map((recipient) => <div className={styles.recipientRow} key={recipient.contactId}>
              <div><strong>{recipient.displayName || "Unnamed contact"}</strong><small>{recipient.phoneE164}</small></div>
              <span>{recipient.state}</span>
            </div>)}
          </div> : <p className={styles.empty}>No eligible recipients were captured.</p>}
          <Pagination page={recipientPage} total={campaign.recipientTotal} pageSize={RECIPIENTS_PAGE_SIZE} param="rp"
            path={`/dashboard/campaigns/${campaign.id}`} query={{ tab: "audience" }} label="Recipient pages" />
        </section>}

        {tab === "history" && <section className={styles.panel} aria-labelledby="audit-heading">
          <div className={styles.panelHeading}><div><h2 id="audit-heading">Audit trail</h2></div><span>{campaign.auditTotal} events</span></div>
          {campaign.audit.length ? <ol className={styles.auditList}>{campaign.audit.map((event, index) => <li key={`${event.createdAt}-${event.action}-${index}`}><div><strong>{event.action.replaceAll("_", " ")}</strong>{event.audienceSourceLabel && <small>Source: {event.audienceSourceLabel}</small>}{event.reviewedAudienceCount !== null && <small>Review acknowledged for {event.reviewedAudienceCount} recipients</small>}</div><time dateTime={event.createdAt}>{dateLabel(event.createdAt)}</time></li>)}</ol> : <p className={styles.empty}>No recorded actions yet.</p>}
          <Pagination page={auditPage} total={campaign.auditTotal} pageSize={AUDIT_PAGE_SIZE} param="ap"
            path={`/dashboard/campaigns/${campaign.id}`} query={{ tab: "history" }} label="History pages" />
        </section>}
      </> : <section className={styles.notice}><strong>Campaign details unavailable</strong><p>Check the campaign ID and database setup, then return to the campaign list.</p></section>}
    </div>
  </DashboardShell>;
}
