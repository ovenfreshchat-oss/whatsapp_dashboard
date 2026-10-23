import type { Metadata } from "next";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { getCampaignDetail } from "@/server/campaigns/admin";
import { getCampaignWorkerReadiness } from "@/server/campaigns/worker";
import { parseTemplateBodyParameters } from "@/server/meta/templates";
import { CampaignControls } from "../campaign-controls";
import styles from "../campaigns.module.css";

export const metadata: Metadata = { title: "Campaign review | The Oven Fresh" };

type PageProps = { params: Promise<{ campaignId: string }> };

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
const deliveryKeys = [
  ["sent", "Sent"], ["delivered", "Delivered"], ["read", "Read"],
  ["failed", "Failed"], ["delivery_conflict", "Status conflict"],
] as const;

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

export default async function CampaignDetailPage({ params }: PageProps) {
  const { campaignId } = await params;
  const detailResult = await Promise.allSettled([getCampaignDetail(campaignId)]);
  const campaign = detailResult[0].status === "fulfilled" ? detailResult[0].value : null;
  const readiness = getCampaignWorkerReadiness();
  const review = campaign ? bodyReview(campaign.templateBody, campaign.bodyParameters) : null;
  const header = campaign?.templateComponents.find((part) => part.type === "HEADER");
  const footer = campaign?.templateComponents.find((part) => part.type === "FOOTER");
  const buttons = campaign?.templateComponents.find((part) => part.type === "BUTTONS")?.buttons ?? [];

  return <DashboardShell label="Campaign review" showMetaSetup>
    <div className={styles.content}>
      <Link href="/dashboard/campaigns" className={styles.backLink}>← All campaigns</Link>
      {campaign ? <>
        <div className={styles.intro}>
          <div><span className={styles.eyebrow}>CAMPAIGN / {campaign.state.toUpperCase()}</span><h1>{campaign.name}<span>.</span></h1><p>Review the frozen audience and message state before changing the schedule.</p></div>
          <Link href={`/dashboard/campaigns/${campaign.id}`} className={styles.refreshLink}>Refresh ↻</Link>
        </div>
        <section className={styles.statusGrid} aria-label="Campaign summary">
          <article className={styles.statusCard}><span className={styles.eyebrow}>FROZEN AUDIENCE</span><h2>{campaign.audienceSource === "import_batch" ? "Selected import" : "All eligible contacts"}</h2><strong>{campaign.audienceCount}</strong><p>{campaign.audienceSourceLabel}. Numbers that replied STOP are skipped.</p></article>
          <article className={styles.statusCard}><span className={styles.eyebrow}>MESSAGE</span><h2>Approved template</h2><strong className={styles.templateName}>{campaign.templateName}</strong><p>{campaign.templateLanguage} · Approval is rechecked before schedule and each send.</p></article>
          <article className={styles.statusCard}><span className={styles.eyebrow}>TIME</span><h2>Scheduled for</h2><strong className={styles.dateValue}>{dateLabel(campaign.scheduledFor)}</strong><p>Created {dateLabel(campaign.createdAt)}.</p></article>
        </section>

        <div className={styles.twoColumn}>
          <section className={styles.panel} aria-labelledby="message-review-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>SCHEDULE REVIEW</span><h2 id="message-review-heading">Message to send</h2></div><span>{campaign.templateLanguage}</span></div>
            {header && <div className={styles.componentReview}>
              <strong>Header {header.format ? `(${header.format})` : ""}</strong>
              {header.format === "IMAGE" ? (
                <div>
                  {campaign.headerMediaUrl ? (
                    <>
                      <p><a href={campaign.headerMediaUrl} target="_blank" rel="noopener noreferrer">{campaign.headerMediaUrl}</a></p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={campaign.headerMediaUrl} alt="Header Preview" className={styles.headerImagePreview} />
                    </>
                  ) : (
                    <p>No header image URL provided</p>
                  )}
                </div>
              ) : (
                <p>{header.text || "No header text"}</p>
              )}
            </div>}
            <p className={styles.helper}>Stored approved template body</p>
            <div className={styles.templatePreview}><p>{campaign.templateBody}</p></div>
            {campaign.bodyParameters.length ? <dl className={styles.parameterList}>
              {campaign.bodyParameters.map((value, index) => <div key={index}><dt>{`{{${review?.keys[index] ?? index + 1}}}`}</dt><dd>{value}</dd></div>)}
            </dl> : <p className={styles.helper}>This body has no variables.</p>}
            <p className={styles.helper}>All recipients receive the same body values.</p>
            {footer && <div className={styles.componentReview}><strong>Footer</strong><p>{footer.text || "No footer text"}</p></div>}
            {buttons.length > 0 && <div className={styles.componentReview}>
              <strong>Buttons</strong>
              <ul>{buttons.map((button, index) => <li key={index}>
                {button.text || button.type || "Button"}{button.url ? ` · ${button.url}` : ""}{button.phoneNumber ? ` · ${button.phoneNumber}` : ""}
              </li>)}</ul>
            </div>}
            <div className={styles.renderedPreview}><strong>Rendered body preview</strong><p>{review?.rendered}</p></div>
          </section>
          <section className={styles.panel} aria-labelledby="audience-review-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>SCHEDULE REVIEW</span><h2 id="audience-review-heading">Frozen audience</h2></div><span>{campaign.audienceCount} total</span></div>
            <p className={styles.helper}>Source: {campaign.audienceSourceLabel}</p>
            <p className={styles.helper}>Showing {campaign.recipientPreview.length} of {campaign.audienceCount} recipients captured in this draft, ordered by addition.</p>
            {campaign.recipientPreview.length ? <div className={styles.recipientList}>
              {campaign.recipientPreview.map((recipient) => <div className={styles.recipientRow} key={recipient.contactId}>
                <div><strong>{recipient.displayName || "Unnamed contact"}</strong><small>{recipient.phoneE164}</small></div>
                <span>{recipient.state}</span>
              </div>)}
            </div> : <p className={styles.empty}>No eligible recipients were captured.</p>}
          </section>
        </div>

        <div className={styles.twoColumn}>
          <section className={styles.panel} aria-labelledby="control-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>CONTROL</span><h2 id="control-heading">Campaign actions</h2></div><span className={styles.statePill}>{campaign.state}</span></div>
            <CampaignControls id={campaign.id} state={campaign.state} audienceCount={campaign.audienceCount} audienceSourceLabel={campaign.audienceSourceLabel} reviewSha256={campaign.reviewSha256} />
            <div className={styles.formNote}><strong>Worker readiness</strong><p>{readiness.enabled ? "Sending policy is configured. A separate worker process must also be running; this page cannot verify its process state." : readiness.reason}</p></div>
          </section>
          <section className={styles.panel} aria-labelledby="counts-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>SEND OUTCOMES</span><h2 id="counts-heading">Recipient states</h2></div><span>{campaign.audienceCount} total</span></div>
            <dl className={styles.countList}>{outcomeKeys.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{campaign.counts[key]}</dd></div>)}</dl>
            <p className={styles.helper}>“Needs reconciliation” means the API outcome is uncertain. Those recipients are parked; the worker will not retry them automatically.</p>
          </section>
        </div>

        <div className={styles.twoColumn}>
          <section className={styles.panel} aria-labelledby="delivery-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>SIGNED WEBHOOKS</span><h2 id="delivery-heading">Delivery status</h2></div></div>
            <dl className={styles.countList}>{deliveryKeys.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{campaign.counts[key]}</dd></div>)}</dl>
            <p className={styles.helper}>Meta acceptance is separate from delivery. Webhook events update these counts when available.</p>
          </section>
          <section className={styles.panel} aria-labelledby="audit-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>HISTORY</span><h2 id="audit-heading">Audit trail</h2></div><span>Latest 50</span></div>
            {campaign.audit.length ? <ol className={styles.auditList}>{campaign.audit.map((event, index) => <li key={`${event.createdAt}-${event.action}-${index}`}><div><strong>{event.action.replaceAll("_", " ")}</strong>{event.audienceSourceLabel && <small>Source: {event.audienceSourceLabel}</small>}{event.reviewedAudienceCount !== null && <small>Review acknowledged for {event.reviewedAudienceCount} recipients</small>}</div><time dateTime={event.createdAt}>{dateLabel(event.createdAt)}</time></li>)}</ol> : <p className={styles.empty}>No recorded actions yet.</p>}
          </section>
        </div>
      </> : <section className={styles.notice}><strong>Campaign details unavailable</strong><p>Check the campaign ID and database setup, then return to the campaign list.</p></section>}
    </div>
  </DashboardShell>;
}
