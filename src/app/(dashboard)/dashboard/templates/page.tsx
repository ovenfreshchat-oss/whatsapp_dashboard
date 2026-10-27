import type { Metadata } from "next";
import Link from "next/link";
import { BackLink } from "@/components/ui/back-link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { getMetaConfigurationStatus } from "@/server/meta/client";
import { syncMetaTemplatesCached } from "@/server/meta/cached";
import type { MetaTemplate } from "@/server/meta/templates";
import styles from "../campaigns/campaigns.module.css";
import { TemplateForm, type TemplateFormInitial } from "./template-form";

export const metadata: Metadata = {
  title: "WhatsApp templates | The Oven Fresh",
  description: "Create and edit WhatsApp message templates.",
};

const EDITABLE = new Set(["APPROVED", "REJECTED", "PAUSED"]);

function initialFrom(template: MetaTemplate): TemplateFormInitial | null {
  const body = template.components.find((c) => c.type === "BODY")?.text;
  if (!body) return null;
  const named = /\{\{\s*[a-z_]/i.test(body);
  return {
    format: named ? "named" : "positional",
    id: template.id,
    name: template.name,
    language: template.language,
    category: template.category,
    body,
    footer: template.components.find((c) => c.type === "FOOTER")?.text ?? "",
    hasImageHeader: template.components.some((c) => c.type === "HEADER" && c.format === "IMAGE"),
  };
}

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ edit?: string | string[] }> }) {
  const { edit } = await searchParams;
  const editId = typeof edit === "string" ? edit : "";
  const configured = getMetaConfigurationStatus().configured;
  let templates: MetaTemplate[] | null = null;
  if (configured) {
    try { templates = (await syncMetaTemplatesCached()).templates; } catch { templates = null; }
  }
  const editing = templates?.find((t) => t.id === editId && EDITABLE.has(t.status));
  const initial = editing ? initialFrom(editing) : null;

  return <DashboardShell label="WhatsApp templates" showMetaSetup>
    <div className={styles.content}>
      <BackLink href="/dashboard">Back to dashboard</BackLink>
      <div className={styles.intro}>
        <div>
          <span className={styles.eyebrow}>MESSAGE TEMPLATES</span>
          <h1>WhatsApp <span>templates</span></h1>
          <p>Write a message, send it to WhatsApp for approval, then use it in a campaign.</p>
        </div>
        {editId && <Link href="/dashboard/templates" className={styles.refreshLink}>+ New template</Link>}
      </div>
      <div className={styles.twoColumn}>
        <section className={styles.panel}>
          <div className={styles.panelHeading}><div><h2>{initial ? `Edit ${initial.name}` : "New template"}</h2></div></div>
          {!configured ? <p className={styles.helper}>Complete the Meta configuration first.</p>
            : editId && !initial ? <p className={styles.helper}>This template cannot be edited here: it is in review, or it has no message text. Pick another one.</p>
            : <TemplateForm key={initial?.id ?? "new"} initial={initial ?? undefined} />}
          {initial && <p className={styles.helper}>Editing sends the template for review again. WhatsApp allows one edit per 24 hours for an approved template. Campaign drafts made from the old version must be created again.</p>}
        </section>
        <section className={styles.panel}>
          <div className={styles.panelHeading}><div><h2>Your templates</h2></div><span>{templates ? `${templates.length} found` : "Unavailable"}</span></div>
          {templates ? templates.length === 0 ? <p className={styles.helper}>No templates yet. Create your first one.</p> : (
            <div className={styles.recipientList}>
              {templates.map((t) => (
                <div className={styles.recipientRow} key={`${t.id}-${t.language}`}>
                  <div><strong>{t.name}</strong><br /><small>{t.language} · {t.category.toLowerCase()} · {t.status.toLowerCase()}</small></div>
                  {EDITABLE.has(t.status) ? <Link href={`/dashboard/templates?edit=${t.id}`} className={styles.backLink}>Edit</Link> : <small>In review</small>}
                </div>
              ))}
            </div>
          ) : <p className={styles.helper}>Templates could not be loaded from Meta.</p>}
        </section>
      </div>
    </div>
  </DashboardShell>;
}
