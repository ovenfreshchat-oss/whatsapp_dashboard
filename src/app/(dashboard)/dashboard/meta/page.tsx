import type { Metadata } from "next";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import {
  getMetaAccountHealth,
  getMetaConfigurationStatus,
  listMetaWebhookSubscriptions,
} from "@/server/meta/client";
import { assertApprovedMarketingTemplate, parseTemplateBodyParameters, syncMetaTemplates, type MetaTemplate } from "@/server/meta/templates";
import { TestSendForm, type TestTemplateOption } from "./test-send-form";
import styles from "./meta.module.css";

export const metadata: Metadata = {
  title: "WhatsApp setup | The Oven Fresh",
  description: "Check the official Meta WhatsApp connection and approved marketing templates.",
};

function testOption(template: MetaTemplate): TestTemplateOption | null {
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

const QUALITY: Record<string, { label: string; className: string }> = {
  RED: { label: "Low", className: "qualityLow" },
  YELLOW: { label: "Medium", className: "qualityMedium" },
  GREEN: { label: "High", className: "qualityHigh" },
};

function QualityBadge({ rating }: { rating: string | null | undefined }) {
  const quality = QUALITY[String(rating ?? "").toUpperCase()];
  if (!quality) return <>{rating ? "Unknown" : "—"}</>;
  return <span className={`${styles.quality} ${styles[quality.className]}`} title={`WhatsApp quality rating: ${rating}`}>
    <i aria-hidden="true" />{quality.label}
  </span>;
}

function dateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function maskedPhone(value: string) {
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

export default async function MetaSetupPage() {
  const configuration = getMetaConfigurationStatus();
  const webhookConfigured = Boolean(process.env.META_APP_SECRET?.trim() && process.env.META_WEBHOOK_VERIFY_TOKEN?.trim());
  const testRecipient = process.env.META_TEST_RECIPIENT_E164?.trim() ?? "";
  const testRecipientConfigured = /^\+[1-9]\d{7,14}$/.test(testRecipient);

  const checks = configuration.configured
    ? await Promise.allSettled([
        getMetaAccountHealth(),
        listMetaWebhookSubscriptions(),
        syncMetaTemplates(),
      ] as const)
    : null;
  const health = checks?.[0].status === "fulfilled" ? checks[0].value : null;
  const subscription = checks?.[1].status === "fulfilled" ? checks[1].value : null;
  const templateSync = checks?.[2].status === "fulfilled" ? checks[2].value : null;
  const templates = templateSync?.templates ?? [];
  const approvedCount = templates.filter((template) => template.status === "APPROVED").length;
  const options = templates.map(testOption).filter((value): value is TestTemplateOption => value !== null);

  const admin = createStaffAdminClient();
  const [historyResult, inboxResult] = admin
    ? await Promise.all([
        admin.from("meta_test_sends")
          .select("id,recipient_e164,template_name,template_language,state,delivery_status,delivery_conflict,wamid,created_at,error_summary")
          .order("created_at", { ascending: false }).limit(8),
        admin.from("meta_webhook_envelopes")
          .select("received_at").order("received_at", { ascending: false }).limit(1),
      ])
    : [null, null];
  const historyReady = Boolean(historyResult && !historyResult.error);
  const inboxReady = Boolean(inboxResult && !inboxResult.error);
  const history = historyReady ? historyResult?.data ?? [] : [];
  const lastWebhookAt = inboxReady ? inboxResult?.data?.[0]?.received_at ?? null : null;
  const canSendTest = Boolean(
    configuration.configured &&
    health?.phoneBelongsToWaba &&
    webhookConfigured &&
    subscription?.isCurrentAppSubscribed &&
    historyReady &&
    inboxReady &&
    testRecipientConfigured &&
    options.length > 0,
  );

  return (
    <DashboardShell label="WhatsApp integration" showMetaSetup>
      <div className={styles.content}>
        <Link href="/dashboard" className={styles.backLink}><span aria-hidden="true">←</span> Back to dashboard</Link>
        <div className={styles.intro}>
          <div>
            <span className={styles.eyebrow}>INTEGRATIONS / META WHATSAPP</span>
            <h1>WhatsApp setup<span>.</span></h1>
            <p>Check the live Cloud API account, approved marketing templates, and webhook delivery.</p>
          </div>
          <div className={styles.introLinks}>
            <Link href="/dashboard/meta/review" className={styles.refreshLink}>Review inbound holds ↗</Link>
            <Link href="/dashboard/meta" className={styles.refreshLink}>Refresh checks ↻</Link>
          </div>
        </div>

        <section className={styles.statusGrid} aria-label="Meta connection checks">
          <article className={styles.statusCard}>
            <div className={styles.cardTop}><span className={styles.cardIcon}>◎</span><span className={configuration.configured && health?.phoneBelongsToWaba ? styles.good : styles.waiting}>{health?.phoneBelongsToWaba ? "Verified live" : "Action needed"}</span></div>
            <h2>Meta account</h2>
            <p>{health?.phoneBelongsToWaba ? "The configured sender belongs to this WhatsApp Business Account." : configuration.configured ? "The account could not be verified with Meta yet." : "Add the server-side Meta settings to begin."}</p>
            <dl>
              <div><dt>WABA</dt><dd>{health?.wabaName ?? (configuration.configured ? "Not verified" : "Not configured")}</dd></div>
              <div><dt>Phone</dt><dd>{health?.phoneNumber?.displayPhoneNumber ?? "—"}</dd></div>
              <div><dt>Quality</dt><dd><QualityBadge rating={health?.phoneNumber?.qualityRating} /></dd></div>
            </dl>
          </article>

          <article className={styles.statusCard}>
            <div className={styles.cardTop}><span className={styles.cardIcon}>◈</span><span className={webhookConfigured && subscription?.isCurrentAppSubscribed && inboxReady ? styles.good : styles.waiting}>{webhookConfigured && subscription?.isCurrentAppSubscribed && inboxReady ? "Ready for events" : "Action needed"}</span></div>
            <h2>Signed webhooks</h2>
            <p>{subscription?.isCurrentAppSubscribed === true ? "This app is subscribed to the WABA." : subscription?.isCurrentAppSubscribed === false ? "This app is not subscribed to the WABA." : "Add META_APP_ID to verify this app’s subscription."}</p>
            <dl>
              <div><dt>Callback path</dt><dd className={styles.code}>/api/webhooks/meta/whatsapp</dd></div>
              <div><dt>Last received</dt><dd>{dateLabel(lastWebhookAt)}</dd></div>
              <div><dt>Inbox</dt><dd>{inboxReady ? "Database ready" : "Apply migration"}</dd></div>
            </dl>
          </article>

          <article className={styles.statusCard}>
            <div className={styles.cardTop}><span className={styles.cardIcon}>▤</span><span className={templateSync ? styles.good : styles.waiting}>{templateSync ? "Live list" : "Action needed"}</span></div>
            <h2>Templates</h2>
            <p>{templateSync ? "Templates were fetched directly from Meta for this account." : "Template access has not been verified."}</p>
            <div className={styles.templateCount}><strong>{templateSync ? approvedCount : "—"}</strong><span>approved of {templateSync ? templates.length : "—"} total</span></div>
            <small>Checked {dateLabel(templateSync?.syncedAt)}</small>
          </article>
        </section>

        {(!configuration.configured || !webhookConfigured || !historyReady || !inboxReady) && (
          <section className={styles.setupNotice} aria-labelledby="setup-needed-heading">
            <h2 id="setup-needed-heading">Complete local setup</h2>
            <p>Secrets stay in the server environment. Add the values from <code>.env.example</code>, restart the app, and apply <code>drizzle/0001_meta_webhook_inbox.sql</code> to your Supabase database.</p>
            {(configuration.missing.length > 0 || configuration.invalid.length > 0) && <p>Missing or invalid: {[...configuration.missing, ...configuration.invalid].join(", ")}.</p>}
            {!webhookConfigured && <p>Webhook verification also needs META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN.</p>}
          </section>
        )}

        <div className={styles.sectionGrid}>
          <section className={styles.panel} aria-labelledby="templates-heading">
            <div className={styles.panelHeading}>
              <div><span className={styles.eyebrow}>ACCOUNT CONTENT</span><h2 id="templates-heading">Marketing templates</h2></div>
              <span>{templateSync ? `${templates.length} found` : "Unavailable"}</span>
            </div>
            {templateSync ? templates.length > 0 ? (
              <div className={styles.templateList}>
                {templates.map((template) => (
                  <article className={styles.templateItem} key={`${template.id}-${template.language}`}>
                    <div><strong>{template.name}</strong><small>{template.language} · {template.category}</small></div>
                    <span className={template.status === "APPROVED" ? styles.approved : styles.otherStatus}>{template.status}</span>
                    <p>{template.components.find((part) => part.type === "BODY")?.text ?? "No text body preview"}</p>
                  </article>
                ))}
              </div>
            ) : <p className={styles.empty}>Meta returned no templates for this WABA.</p> : <p className={styles.empty}>Templates will appear after the account and token are configured and reachable.</p>}
          </section>

          <section className={styles.panel} aria-labelledby="test-heading">
            <div className={styles.panelHeading}>
              <div><span className={styles.eyebrow}>OPTIONAL DIAGNOSTIC</span><h2 id="test-heading">One-message test</h2></div>
            </div>
            {canSendTest ? <TestSendForm recipient={testRecipient} options={options} /> : (
              <div className={styles.empty}>
                <p>Test sending unlocks after the sender, this app’s webhook subscription, database migration, and approved marketing template are verified. Bulk campaigns use imported contacts and do not need a fixed test number.</p>
                {!testRecipientConfigured && <p>For this optional check, add a permitted test number as META_TEST_RECIPIENT_E164.</p>}
              </div>
            )}
          </section>
        </div>

        <section className={styles.panel} aria-labelledby="history-heading">
          <div className={styles.panelHeading}>
            <div><span className={styles.eyebrow}>MESSAGE TRACKING</span><h2 id="history-heading">Recent test attempts</h2></div>
          </div>
          {history.length > 0 ? (
            <div className={styles.historyList}>
              {history.map((item) => (
                <div className={styles.historyRow} key={item.id}>
                  <div><strong>{item.template_name} · {item.template_language}</strong><small>{maskedPhone(item.recipient_e164)} · {dateLabel(item.created_at)}</small></div>
                  <span>{item.delivery_conflict ? "Status conflict" : item.delivery_status ?? (item.state === "accepted" ? "Accepted by Meta" : item.state)}</span>
                </div>
              ))}
            </div>
          ) : <p className={styles.empty}>{historyReady ? "No test messages have been sent." : "Apply the Meta database migration to store message history."}</p>}
        </section>
      </div>
    </DashboardShell>
  );
}
