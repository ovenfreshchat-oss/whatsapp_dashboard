import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/ui/back-link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { Pagination, pageFrom } from "@/components/ui/pagination";
import { BatchReviewForm } from "../../batch-review-form";
import { ActiveSwitch, BatchActiveButtons } from "../../number-switch";
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

type NumberRow = { id: string; phone_e164: string; display_name: string | null; campaign_active: boolean };
const NUMBERS_SIZE = 25;

export default async function ImportReviewPage({ params, searchParams }: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ tab?: string | string[]; np?: string | string[]; q?: string | string[] }>;
}) {
  const { batchId } = await params;
  const query = await searchParams;
  const rawTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const tab: "numbers" | "consent" = rawTab === "consent" ? "consent" : "numbers";
  const numbersPage = pageFrom(query.np);
  const rawSearch = Array.isArray(query.q) ? query.q[0] : query.q;
  const search = (rawSearch ?? "").replace(/[^\p{L}\p{N}+ .'-]/gu, "").trim().slice(0, 40);
  const searchDigits = search.replace(/[^+\d]/g, "");
  // Match a name, or a phone number typed in any format.
  const searchFilter = search
    ? [`display_name.ilike.%${search}%`, searchDigits.length >= 2 ? `phone_e164.ilike.%${searchDigits}%` : null].filter(Boolean).join(",")
    : "";
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

  // Numbers tab: every number in this upload, with its on/off state.
  const first = (numbersPage - 1) * NUMBERS_SIZE;
  const listQuery = tab === "numbers" ? (() => {
    const base = admin.from("contacts")
      .select("id,phone_e164,display_name,campaign_active,contact_batch_members!inner(batch_id)", { count: "exact" })
      .eq("contact_batch_members.batch_id", batchId);
    return (searchFilter ? base.or(searchFilter) : base).order("phone_e164").range(first, first + NUMBERS_SIZE - 1);
  })() : null;
  const [numbersResult, inactiveResult] = tab === "numbers"
    ? await Promise.all([
        listQuery,
        admin.from("contacts")
          .select("id,contact_batch_members!inner(batch_id)", { count: "exact", head: true })
          .eq("contact_batch_members.batch_id", batchId).eq("campaign_active", false),
      ])
    : [null, null];
  const numbersReady = Boolean(numbersResult && !numbersResult.error && inactiveResult && !inactiveResult.error);
  const numberRows = (numbersReady ? numbersResult?.data ?? [] : []) as NumberRow[];
  const totalNumbers = numbersResult?.count ?? 0;
  const inactiveNumbers = inactiveResult?.count ?? 0;
  const optOutResult = numberRows.length
    ? await admin.from("opt_out_numbers").select("phone_e164")
        .in("phone_e164", numberRows.map((row) => row.phone_e164)).is("released_at", null)
    : null;
  const optedOut = new Set((optOutResult?.data ?? []).map((row: { phone_e164: string }) => row.phone_e164));
  const ready = !claimsResult.error && !reviewableResult.error && !errorsResult.error;
  const claims = (ready ? claimsResult.data ?? [] : []) as Claim[];
  const ids = [...new Set(claims.map((claim) => claim.contact_id))];
  const contactsResult = ids.length ? await admin.from("contacts")
    .select("id,phone_e164,display_name").in("id", ids) : null;
  const contacts = new Map((contactsResult?.data ?? []).map((contact) =>
    [contact.id, contact]));
  const contactsReady = ids.length === 0 || Boolean(contactsResult && !contactsResult.error && contacts.size === ids.length);
  const reviewableCount = ready ? reviewableResult.count ?? 0 : 0;

  return <DashboardShell label="Contacts · upload" showMetaSetup><div className={styles.content}>
    <BackLink href="/dashboard/contacts?tab=uploads">Uploads</BackLink>
    <div className={styles.pageHead}>
      <div><h1 className={styles.fileTitle}>{batch.file_name}</h1><p className={styles.muted}>Uploaded {dateLabel(batch.created_at).slice(0, 10)}</p></div>
    </div>
    <nav className={styles.tabs} aria-label="Upload sections">
      <Link href={`/dashboard/contacts/imports/${batchId}`} className={tab === "numbers" ? styles.tabOn : undefined} aria-current={tab === "numbers" ? "page" : undefined}>Numbers</Link>
      <Link href={`/dashboard/contacts/imports/${batchId}?tab=consent`} className={tab === "consent" ? styles.tabOn : undefined} aria-current={tab === "consent" ? "page" : undefined}>Consent review{(claimsResult.count ?? 0) > 0 && <b className={styles.badge}>{claimsResult.count}</b>}</Link>
    </nav>

    {tab === "numbers" && <section className={styles.panel} aria-label="Numbers in this upload">
      {!numbersReady ? <p className={styles.empty}>Numbers could not be loaded. Apply <code>drizzle/0020_contact_campaign_active.sql</code> and refresh.</p> : <>
        <form action={`/dashboard/contacts/imports/${batchId}`} className={styles.searchForm} role="search">
          <label className={styles.searchBox}><Search size={18} aria-hidden="true" /><input name="q" defaultValue={search} placeholder="Search by number or name" maxLength={40} aria-label="Search numbers in this upload" /></label>
          <button className={styles.button} type="submit">Search</button>
          {search && <Link href={`/dashboard/contacts/imports/${batchId}`} className={styles.secondaryButton}>Clear</Link>}
        </form>
        <div className={styles.numbersHead}>
          <p className={styles.muted}>{search
            ? <><strong>{totalNumbers}</strong> found</>
            : <><strong>{totalNumbers - inactiveNumbers}</strong> active · <strong>{inactiveNumbers}</strong> inactive. Inactive numbers get no campaigns until you switch them back on.</>}</p>
          {!search && totalNumbers > 0 && <BatchActiveButtons batchId={batchId} />}
        </div>
        {numberRows.length ? <ul className={styles.rowList}>{numberRows.map((row) => <li key={row.id} className={styles.numRow}>
          <span className={styles.rowMain}><strong>{row.display_name ?? row.phone_e164}</strong>{row.display_name && <small>{row.phone_e164}</small>}</span>
          {optedOut.has(row.phone_e164)
            ? <span className={styles.optedOut} title="This number is on the do-not-contact list">Opted out</span>
            : <ActiveSwitch contactId={row.id} initial={row.campaign_active} name={row.display_name ?? row.phone_e164} />}
        </li>)}</ul> : <p className={styles.empty}>{search ? "No number or name matches your search." : "No numbers are linked to this upload."}</p>}
        <Pagination page={numbersPage} total={totalNumbers} pageSize={NUMBERS_SIZE} param="np" path={`/dashboard/contacts/imports/${batchId}`} query={{ q: search || undefined }} label="Number pages" />
      </>}
    </section>}

    {tab === "consent" && <>
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
    </>}
  </div></DashboardShell>;
}
