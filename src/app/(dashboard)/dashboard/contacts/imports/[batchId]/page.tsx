import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { BatchReviewForm } from "../../batch-review-form";
import styles from "../../contacts.module.css";

export const metadata: Metadata = { title: "Import consent review | The Oven Fresh" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Claim = {
  id: string; contact_id: string; import_row_number: number;
  evidence_reference: string | null; occurred_at: string | null; occurred_on: string | null;
};

function dateLabel(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function ImportReviewPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!UUID.test(batchId)) notFound();
  const admin = createStaffAdminClient();
  if (!admin) throw new Error("The contact database is unavailable.");
  const reviewableDateCutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [batchResult, claimsResult, reviewableResult, errorsResult] = await Promise.all([
    admin.from("contact_import_batches")
      .select("id,file_name,file_sha256,created_at,total_rows,accepted_rows,rejected_rows,pending_claims,negative_consent_rows")
      .eq("id", batchId).single(),
    admin.from("contact_consent_events")
      .select("id,contact_id,import_row_number,evidence_reference,occurred_at,occurred_on", { count: "exact" })
      .eq("import_batch_id", batchId).eq("decision", "grant")
      .eq("verification_status", "pending")
      .order("import_row_number", { ascending: true }).limit(100),
    admin.from("contact_consent_events")
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", batchId).eq("decision", "grant")
      .eq("verification_status", "pending")
      .not("evidence_reference", "is", null).not("occurred_at", "is", null)
      .lte("occurred_at", new Date().toISOString())
      .or(`occurred_on.is.null,occurred_on.lte.${reviewableDateCutoff}`),
    admin.from("contact_import_row_errors")
      .select("row_number,code,message", { count: "exact" })
      .eq("batch_id", batchId).order("row_number", { ascending: true }).limit(30),
  ]);
  if (batchResult.error || !batchResult.data) notFound();
  const batch = batchResult.data;
  const ready = !claimsResult.error && !reviewableResult.error && !errorsResult.error;
  const claims = (ready ? claimsResult.data ?? [] : []) as Claim[];
  const ids = [...new Set(claims.map((claim) => claim.contact_id))];
  const contactsResult = ids.length ? await admin.from("contacts")
    .select("id,phone_e164,display_name").in("id", ids) : null;
  const contacts = new Map((contactsResult?.data ?? []).map((contact) =>
    [contact.id, contact]));
  const contactsReady = ids.length === 0 || Boolean(contactsResult && !contactsResult.error && contacts.size === ids.length);
  const reviewableCount = ready ? reviewableResult.count ?? 0 : 0;

  return <DashboardShell label="Contacts · import review" showMetaSetup><div className={styles.content}>
    <Link href="/dashboard/contacts" className={styles.backLink}>← Back to contacts</Link>
    <div className={styles.intro}><div><span className={styles.eyebrow}>CONTACTS / IMPORT REVIEW</span><h1>{batch.file_name}<span>.</span></h1><p>Uploaded {dateLabel(batch.created_at)} · File hash {batch.file_sha256.slice(0, 12)}…</p></div><span className={styles.countPill}>{claimsResult.count ?? 0} pending claims</span></div>
    <div className={styles.statGrid}><span><strong>{batch.accepted_rows}</strong> imported</span><span><strong>{batch.rejected_rows}</strong> skipped rows</span><span><strong>{batch.negative_consent_rows}</strong> explicit No suppressions</span><span><strong>{reviewableCount}</strong> evidenced claims ready</span></div>
    {!ready && <section className={styles.notice}><strong>Review data is unavailable.</strong><p>Refresh after the contacts migration is applied. No consent can be approved from this page until the evidence is loaded.</p></section>}
    {ready && !contactsReady && <section className={styles.notice}><strong>Contact details are unavailable.</strong><p>Refresh before reviewing consent. No batch approval is available until the contact list loads.</p></section>}
    <section className={styles.panel}><div className={styles.panelHeading}><div><span className={styles.eyebrow}>FILE EVIDENCE</span><h2>Pending “Yes” claims</h2></div><span>{claimsResult.count ?? 0} total</span></div>
      <p className={styles.muted}>Showing the first {claims.length} pending claims. Check the original uploaded file for every person before approving the batch.</p>
      {ready && contactsReady && claims.length ? <div className={styles.tableWrap}><table><thead><tr><th>Row</th><th>Contact</th><th>WhatsApp number</th><th>Evidence reference</th><th>Consent date</th></tr></thead><tbody>{claims.map((claim) => {
        const contact = contacts.get(claim.contact_id);
        return <tr key={claim.id}><td>{claim.import_row_number}</td><td>{contact?.display_name ?? "—"}</td><td>{contact?.phone_e164 ?? "—"}</td><td>{claim.evidence_reference ?? "Missing"}</td><td>{claim.occurred_on ? `${claim.occurred_on} (date only)` : dateLabel(claim.occurred_at)}</td></tr>;
      })}</tbody></table></div> : ready && contactsReady && <p className={styles.empty}>No pending consent claims in this import.</p>}
      {(claimsResult.count ?? 0) > claims.length && <p className={styles.muted}>Additional claims are in the original file. The batch action only approves rows with evidence and a date; review them before using it.</p>}
    </section>
    {ready && contactsReady && <section className={styles.panel}><div className={styles.panelHeading}><div><span className={styles.eyebrow}>APPROVAL</span><h2>Review this batch</h2></div><span>{reviewableCount} eligible for review</span></div><BatchReviewForm batchId={batchId} idempotencyKey={randomUUID()} reviewableCount={reviewableCount} /></section>}
    <section className={styles.panel}><div className={styles.panelHeading}><div><span className={styles.eyebrow}>VALIDATION</span><h2>Skipped row errors</h2></div><span>{errorsResult.count ?? 0} issues</span></div>
      {(errorsResult.data ?? []).length ? <div className={styles.tableWrap}><table><thead><tr><th>Row</th><th>Issue</th></tr></thead><tbody>{(errorsResult.data ?? []).map((error, index) => <tr key={`${error.row_number}-${error.code}-${index}`}><td>{error.row_number}</td><td>{error.message}</td></tr>)}</tbody></table></div> : <p className={styles.empty}>No skipped row errors.</p>}
    </section>
  </div></DashboardShell>;
}
