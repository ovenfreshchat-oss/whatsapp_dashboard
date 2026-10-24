import type { Metadata } from "next";
import Link from "next/link";
import { Pagination, pageFrom } from "@/components/ui/pagination";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { ContactImportForm } from "./import-form";
import { ConsentReviewForm } from "./review-form";
import styles from "./contacts.module.css";

export const metadata: Metadata = {
  title: "Contacts | The Oven Fresh",
  description: "Import WhatsApp contacts and review marketing consent evidence.",
};

type Contact = { id: string; phone_e164: string; display_name: string | null; created_at: string };
type Claim = {
  id: string;
  contact_id: string;
  import_batch_id: string | null;
  import_row_number: number | null;
  evidence_reference: string | null;
  occurred_at: string | null;
  occurred_on: string | null;
  recorded_at: string;
};
type Batch = {
  id: string;
  file_name: string;
  created_at: string;
  total_rows: number;
  accepted_rows: number;
  rejected_rows: number;
  pending_claims: number;
};

function dateLabel(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function consentDateLabel(dateOnly: string | null, exactTime: string | null) {
  return dateOnly ? `${dateOnly} (date only)` : dateLabel(exactTime);
}

export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; page?: string | string[]; cp?: string | string[]; bp?: string | string[] }> }) {
  const params = await searchParams;
  const rawQuery = params.q;
  const page = pageFrom(params.page);
  const claimPage = pageFrom(params.cp);
  const batchPage = pageFrom(params.bp);
  const CONTACTS_SIZE = 25, CLAIMS_SIZE = 10, BATCHES_SIZE = 5;
  const range = (p: number, size: number) => [(p - 1) * size, p * size - 1] as const;
  const search = typeof rawQuery === "string" ? rawQuery.trim() : "";
  const phoneSearch = search.replace(/[^+\d]/g, "").slice(0, 20);
  const reviewableDateCutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const admin = createStaffAdminClient();
  const [contactCountResult, recentResult, claimResult, batchResult] = admin
    ? await Promise.all([
        admin.from("contacts").select("id", { count: "exact", head: true }),
        admin.from("contacts").select("id,phone_e164,display_name,created_at", { count: "exact" })
          .ilike("phone_e164", phoneSearch ? `%${phoneSearch}%` : "%")
          .order("created_at", { ascending: false }).order("id").range(...range(page, CONTACTS_SIZE)),
        admin.from("contact_consent_events")
          .select("id,contact_id,import_batch_id,import_row_number,evidence_reference,occurred_at,occurred_on,recorded_at", { count: "exact" })
          .eq("decision", "grant").eq("verification_status", "pending")
          .order("recorded_at", { ascending: false }).order("id").range(...range(claimPage, CLAIMS_SIZE)),
        admin.from("contact_import_batches")
          .select("id,file_name,created_at,total_rows,accepted_rows,rejected_rows,pending_claims", { count: "exact" })
          .order("created_at", { ascending: false }).order("id").range(...range(batchPage, BATCHES_SIZE)),
      ])
    : [null, null, null, null];
  const storageReady = Boolean(contactCountResult && !contactCountResult.error &&
    recentResult && !recentResult.error && claimResult && !claimResult.error &&
    batchResult && !batchResult.error);
  const recent = (storageReady ? recentResult?.data ?? [] : []) as Contact[];
  const claims = (storageReady ? claimResult?.data ?? [] : []) as Claim[];
  const batches = (storageReady ? batchResult?.data ?? [] : []) as Batch[];
  const claimContactIds = [...new Set(claims.map((claim) => claim.contact_id))];
  const claimContactsResult = admin && claimContactIds.length
    ? await admin.from("contacts").select("id,phone_e164,display_name").in("id", claimContactIds)
    : null;
  const claimContacts = new Map<string, Pick<Contact, "id" | "phone_e164" | "display_name">>(
    ((claimContactsResult?.data ?? []) as Pick<Contact, "id" | "phone_e164" | "display_name">[])
      .map((contact) => [contact.id, contact]),
  );
  const claimContactsReady = claimContactIds.length === 0 ||
    Boolean(claimContactsResult && !claimContactsResult.error && claimContacts.size === claimContactIds.length);

  return (
    <DashboardShell label="Contacts" showMetaSetup>
      <div className={styles.content}>
        <Link href="/dashboard" className={styles.backLink}>← Back to dashboard</Link>
        <div className={styles.intro}>
          <div><span className={styles.eyebrow}>AUDIENCE / CONTACTS</span><h1>Contacts<span>.</span></h1><p>Import people from a table, then review proof of WhatsApp marketing consent.</p></div>
          <div><span className={styles.countPill}>{storageReady ? `${contactCountResult?.count ?? 0} contacts` : "Database setup needed"}</span> <Link href="/dashboard/opt-outs" className={styles.secondaryButton}>Opt-out list</Link></div>
        </div>
        {!storageReady && <section className={styles.notice}><strong>Apply the contacts migration</strong><p>File inspection works now. Saving contacts and reviewing consent require <code>drizzle/0002_contacts.sql</code> in Supabase.</p></section>}

        <section className={styles.panel} aria-labelledby="import-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>STEP 1</span><h2 id="import-heading">Upload contacts</h2></div><span>CSV · Excel · Word</span></div>
          <ContactImportForm />
        </section>

        <div className={styles.twoColumn}>
          <section className={styles.panel} aria-labelledby="review-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>STEP 2</span><h2 id="review-heading">Consent claims to review</h2></div><span>{storageReady ? `${claimResult?.count ?? 0} pending` : "Unavailable"}</span></div>
            <p className={styles.muted}>An imported consent claim does not make a contact eligible for a campaign. Check the original evidence and enter the notice they agreed to before approving.</p>
            {storageReady && !claimContactsReady && <p className={styles.notice}>Contact details for these claims could not be loaded. Refresh before reviewing consent.</p>}
            {claimContactsReady && claims.length ? <div className={styles.claimList}>
              {claims.map((claim) => {
                const contact = claimContacts.get(claim.contact_id);
                return <article className={styles.claimCard} key={claim.id}>
                  <div className={styles.claimTop}><strong>{contact?.display_name || contact?.phone_e164 || "Contact"}</strong><small>{contact?.phone_e164 ?? ""} · Import row {claim.import_row_number ?? "—"}</small></div>
                  <dl className={styles.claimFacts}><div><dt>Evidence</dt><dd>{claim.evidence_reference ?? "Missing"}</dd></div><div><dt>Consent date or time</dt><dd>{consentDateLabel(claim.occurred_on, claim.occurred_at)}</dd></div></dl>
                  <ConsentReviewForm eventId={claim.id} canGrant={Boolean(claim.evidence_reference && claim.occurred_at &&
                    (!claim.occurred_on || claim.occurred_on <= reviewableDateCutoff))} />
                </article>;
              })}
            </div> : claimContactsReady && <p className={styles.empty}>{storageReady ? "No pending consent claims." : "Apply the contacts migration to view consent claims."}</p>}
            {storageReady && <Pagination page={claimPage} total={claimResult?.count ?? 0} pageSize={CLAIMS_SIZE} param="cp" path="/dashboard/contacts" query={{ q: search || undefined, page: page > 1 ? String(page) : undefined, bp: batchPage > 1 ? String(batchPage) : undefined }} label="Consent claim pages" />}
          </section>

          <section className={styles.panel} aria-labelledby="batches-heading">
            <div className={styles.panelHeading}><div><span className={styles.eyebrow}>IMPORT HISTORY</span><h2 id="batches-heading">Recent uploads</h2></div></div>
            {batches.length ? <div className={styles.batchList}>{batches.map((batch) => <div className={styles.batchRow} key={batch.id}><div><strong>{batch.file_name}</strong><small>{dateLabel(batch.created_at)}</small></div><div><span>{batch.accepted_rows} imported · {batch.rejected_rows} skipped · {batch.pending_claims} claims</span><Link className={styles.contactLink} href={`/dashboard/contacts/imports/${batch.id}`}>Review batch →</Link></div></div>)}</div> : <p className={styles.empty}>{storageReady ? "No files imported yet." : "Import history will appear after setup."}</p>}
            {storageReady && <Pagination page={batchPage} total={batchResult?.count ?? 0} pageSize={BATCHES_SIZE} param="bp" path="/dashboard/contacts" query={{ q: search || undefined, page: page > 1 ? String(page) : undefined, cp: claimPage > 1 ? String(claimPage) : undefined }} label="Upload pages" />}
          </section>
        </div>

        <section className={styles.panel} aria-labelledby="recent-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>DIRECTORY</span><h2 id="recent-heading">Find a contact</h2></div><span>{phoneSearch ? `${recentResult?.count ?? 0} found` : `${contactCountResult?.count ?? 0} total`}</span></div>
          <form action="/dashboard/contacts" className={styles.searchForm}><label className={styles.field}><span>Search by phone number</span><input name="q" defaultValue={search} placeholder="+91…" maxLength={30} /></label><button className={styles.secondaryButton} type="submit">Search</button></form>
          {recent.length ? <div className={styles.tableWrap}><table><thead><tr><th>Title or name</th><th>WhatsApp number</th><th>Added</th><th></th></tr></thead><tbody>{recent.map((contact) => <tr key={contact.id}><td>{contact.display_name ?? "—"}</td><td>{contact.phone_e164}</td><td>{dateLabel(contact.created_at)}</td><td><Link className={styles.contactLink} href={`/dashboard/contacts/${contact.id}`}>Consent record →</Link></td></tr>)}</tbody></table></div> : <p className={styles.empty}>{storageReady ? "No matching contacts. Upload a table above or try another number." : "Contact list will appear after setup."}</p>}
          {storageReady && <Pagination page={page} total={recentResult?.count ?? 0} pageSize={CONTACTS_SIZE} path="/dashboard/contacts" query={{ q: search || undefined, cp: claimPage > 1 ? String(claimPage) : undefined, bp: batchPage > 1 ? String(batchPage) : undefined }} label="Contact pages" />}
        </section>
      </div>
    </DashboardShell>
  );
}
