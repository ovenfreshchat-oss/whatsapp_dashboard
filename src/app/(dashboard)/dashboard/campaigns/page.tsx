import type { Metadata } from "next";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { listCampaigns, listCampaignImportBatches } from "@/server/campaigns/admin";
import { getMetaConfigurationStatus } from "@/server/meta/client";
import { assertApprovedMarketingTemplate, parseTemplateBodyParameters, syncMetaTemplates, type MetaTemplate } from "@/server/meta/templates";
import { AutoRefresh } from "./auto-refresh";
import { CreateCampaignForm, type CampaignTemplateOption } from "./create-form";
import styles from "./campaigns.module.css";

export const metadata: Metadata = {
  title: "WhatsApp campaigns | The Oven Fresh",
  description: "Review and schedule WhatsApp marketing campaigns.",
};

function templateOption(template: MetaTemplate): CampaignTemplateOption | null {
  if (template.status !== "APPROVED" || template.category !== "MARKETING") return null;
  const body = template.components.find((part) => part.type === "BODY")?.text;
  if (!body) return null;
  try {
    const spec = parseTemplateBodyParameters(body);
    const validation = assertApprovedMarketingTemplate(template, Array(spec.keys.length).fill("Preview value"));
    return {
      key: `${template.name}|${template.language}`,
      label: `${template.name} · ${template.language}${validation.headerFormat === "IMAGE" ? " (Image header)" : ""}`,
      body,
      parameterKeys: spec.keys,
      headerFormat: validation.headerFormat,
    };
  } catch {
    return null;
  }
}

function dateLabel(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function CampaignsPage() {
  const configuration = getMetaConfigurationStatus();
  const [campaignResult, batchResult, templateResult] = await Promise.allSettled([
    listCampaigns(),
    listCampaignImportBatches(),
    configuration.configured ? syncMetaTemplates() : Promise.resolve(null),
  ]);
  const campaigns = campaignResult.status === "fulfilled" ? campaignResult.value : null;
  const batches = batchResult.status === "fulfilled" ? batchResult.value : null;
  const templates = templateResult.status === "fulfilled" ? templateResult.value?.templates ?? null : null;
  const options = (templates ?? []).map(templateOption)
    .filter((value): value is CampaignTemplateOption => value !== null);
  const canCreate = Boolean(campaigns && batches && options.length);

  return <DashboardShell label="WhatsApp campaigns" showMetaSetup>
    <div className={styles.content}>
      <Link href="/dashboard" className={styles.backLink}>← Back to dashboard</Link>
      <div className={styles.intro}>
        <div>
          <span className={styles.eyebrow}>AUDIENCE / CAMPAIGNS</span>
          <h1>WhatsApp campaigns<span>.</span></h1>
          <p>Pick a message and audience, then send or schedule it on the next screen.</p>
        </div>
        <div className={styles.buttonRow}>
          {campaigns?.some((c) => c.state === "scheduled" || c.state === "running") && <AutoRefresh intervalMs={8000} />}
          <Link href="/dashboard/campaigns" className={styles.refreshLink}>Refresh ↻</Link>
        </div>
      </div>

      {!campaigns && <section className={styles.notice}>
        <strong>Campaign storage needs setup</strong>
        <p>Apply <code>drizzle/0001_meta_webhook_inbox.sql</code>, <code>drizzle/0002_contacts.sql</code>, then <code>drizzle/0003_campaigns.sql</code> to the configured Supabase database.</p>
      </section>}

      <div className={styles.stack}>
        <section className={styles.panel} aria-labelledby="create-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>NEW CAMPAIGN</span><h2 id="create-heading">Message and audience</h2></div><span>Nothing sends yet</span></div>
          {canCreate ? <CreateCampaignForm options={options} batches={batches ?? []} /> : <p className={styles.empty}>Draft creation becomes available after import history, campaign storage, and a supported approved marketing template are ready.</p>}
        </section>
        <section className={styles.panel} aria-labelledby="campaigns-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>CAMPAIGNS</span><h2 id="campaigns-heading">Recent campaigns</h2></div><span>{campaigns ? `${campaigns.length} shown` : "Unavailable"}</span></div>
          {campaigns?.length ? <div className={styles.campaignList}>
            {campaigns.map((campaign) => <Link className={styles.campaignRow} key={campaign.id} href={`/dashboard/campaigns/${campaign.id}${campaign.state === "draft" ? "" : "/analytics"}`}>
              <div><strong>{campaign.name}</strong><small>{campaign.audienceSourceLabel} · {campaign.templateName} · {campaign.templateLanguage} · {campaign.audienceCount} recipients</small></div>
              <div><span className={styles.statePill}>{campaign.state}</span><small>{campaign.scheduledFor ? dateLabel(campaign.scheduledFor) : "Not scheduled"}</small></div>
            </Link>)}
          </div> : <p className={styles.empty}>{campaigns ? "No campaigns yet. Create a draft to review its frozen audience." : "Apply the campaign migration to view campaigns."}</p>}
        </section>
      </div>
    </div>
  </DashboardShell>;
}
