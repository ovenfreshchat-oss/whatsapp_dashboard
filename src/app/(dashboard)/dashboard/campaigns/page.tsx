import type { Metadata } from "next";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { CAMPAIGNS_PAGE_SIZE, listCampaigns, listCampaignImportBatches } from "@/server/campaigns/admin";
import { getMetaConfigurationStatus } from "@/server/meta/client";
import { assertApprovedMarketingTemplate, parseTemplateBodyParameters, syncMetaTemplates, type MetaTemplate } from "@/server/meta/templates";
import { Pagination } from "@/components/ui/pagination";
import { AutoRefresh } from "./auto-refresh";
import { CreateCampaignForm, type CampaignTemplateOption } from "./create-form";
import { RefreshButton } from "@/components/ui/refresh-button";
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

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ page?: string | string[]; view?: string | string[] }> }) {
  const params = await searchParams;
  const rawPage = params.page;
  const requestedPage = Number.parseInt(Array.isArray(rawPage) ? rawPage[0] : rawPage ?? "1", 10);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const creating = (Array.isArray(params.view) ? params.view[0] : params.view) === "new";

  // One job per screen: the list by default, the create form only when asked for.
  // The Meta template sync is slow, so it only runs on the create screen.
  if (creating) {
    const configuration = getMetaConfigurationStatus();
    const [batchResult, templateResult] = await Promise.allSettled([
      listCampaignImportBatches(),
      configuration.configured ? syncMetaTemplates() : Promise.resolve(null),
    ]);
    const batches = batchResult.status === "fulfilled" ? batchResult.value : null;
    const templates = templateResult.status === "fulfilled" ? templateResult.value?.templates ?? null : null;
    const options = (templates ?? []).map(templateOption)
      .filter((value): value is CampaignTemplateOption => value !== null);
    const canCreate = Boolean(batches && options.length);

    return <DashboardShell label="New WhatsApp campaign" showMetaSetup>
      <div className={styles.content}>
        <div className={styles.pageHead}>
          <Link href="/dashboard/campaigns" className={styles.backLink}>← Campaigns</Link>
          <h1>New campaign</h1>
        </div>
        <section className={styles.panel} aria-label="Message and audience">
          {canCreate ? <CreateCampaignForm options={options} batches={batches ?? []} /> : <p className={styles.empty}>Draft creation becomes available after import history, campaign storage, and a supported approved marketing template are ready.</p>}
        </section>
      </div>
    </DashboardShell>;
  }

  const [campaignResult] = await Promise.allSettled([listCampaigns(page)]);
  const campaignPage = campaignResult.status === "fulfilled" ? campaignResult.value : null;
  const campaigns = campaignPage?.items ?? null;
  const totalCampaigns = campaignPage?.total ?? 0;

  return <DashboardShell label="WhatsApp campaigns" showMetaSetup>
    <div className={styles.content}>
      <div className={styles.pageHead}>
        <h1>Campaigns{campaigns ? <small>{totalCampaigns}</small> : null}</h1>
        <div className={styles.buttonRow}>
          {campaigns?.some((c) => c.state === "scheduled" || c.state === "running") && <AutoRefresh intervalMs={8000} />}
          <RefreshButton className={styles.refreshLink} />
          <Link href="/dashboard/campaigns?view=new" className={styles.newButton}>+ New campaign</Link>
        </div>
      </div>

      {!campaigns && <section className={styles.notice}>
        <strong>Campaign storage needs setup</strong>
        <p>Apply <code>drizzle/0001_meta_webhook_inbox.sql</code>, <code>drizzle/0002_contacts.sql</code>, then <code>drizzle/0003_campaigns.sql</code> to the configured Supabase database.</p>
      </section>}

      <section className={styles.panel} aria-label="Campaigns">
        {campaigns?.length ? <div className={styles.campaignList}>
          {campaigns.map((campaign) => <Link className={styles.campaignRow} key={campaign.id} href={`/dashboard/campaigns/${campaign.id}${campaign.state === "draft" ? "" : "/analytics"}`}>
            <div><strong>{campaign.name}</strong><small>{campaign.audienceCount} recipients · {campaign.templateName}</small></div>
            <div><span className={styles.statePill}>{campaign.state}</span><small>{campaign.scheduledFor ? dateLabel(campaign.scheduledFor) : "Not scheduled"}</small></div>
          </Link>)}
        </div> : <p className={styles.empty}>{campaigns ? "No campaigns yet. Tap “+ New campaign” to create your first one." : "Apply the campaign migration to view campaigns."}</p>}
        {campaigns && <Pagination page={page} total={totalCampaigns} pageSize={CAMPAIGNS_PAGE_SIZE} path="/dashboard/campaigns" label="Campaign pages" />}
      </section>
    </div>
  </DashboardShell>;
}
