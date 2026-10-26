import type { Metadata } from "next";
import Link from "next/link";
import { Pagination, pageFrom } from "@/components/ui/pagination";
import { ChevronRight } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { ContactImportForm } from "./import-form";
import styles from "./contacts.module.css";

export const metadata: Metadata = {
  title: "Contacts | The Oven Fresh",
  description: "Import WhatsApp contacts and review marketing consent evidence.",
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

export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ bp?: string | string[] }> }) {
  const batchPage = pageFrom((await searchParams).bp);
  const BATCHES_SIZE = 8;
  const first = (batchPage - 1) * BATCHES_SIZE;
  const admin = createStaffAdminClient();
  const [contactCountResult, batchResult] = admin
    ? await Promise.all([
        admin.from("contacts").select("id", { count: "exact", head: true }),
        admin.from("contact_import_batches")
          .select("id,file_name,created_at,total_rows,accepted_rows,rejected_rows,pending_claims", { count: "exact" })
          .order("created_at", { ascending: false }).order("id").range(first, first + BATCHES_SIZE - 1),
      ])
    : [null, null];
  const storageReady = Boolean(contactCountResult && !contactCountResult.error && batchResult && !batchResult.error);
  const batches = (storageReady ? batchResult?.data ?? [] : []) as Batch[];

  return (
    <DashboardShell label="Contacts" showMetaSetup>
      <div className={styles.content}>
        <div className={styles.pageHead}>
          <h1>Contacts{storageReady && <small>{contactCountResult?.count ?? 0}</small>}</h1>
          <div className={styles.actions}>
            <Link href="/dashboard/opt-outs" className={styles.secondaryButton}>Opt-out list</Link>
          </div>
        </div>

        {!storageReady && <section className={styles.notice}><strong>Database setup needed</strong><p>Apply <code>drizzle/0002_contacts.sql</code> in Supabase to save contacts.</p></section>}

        <section className={styles.panel} aria-labelledby="import-heading">
          <div className={styles.panelHeading}><h2 id="import-heading">Upload a file</h2><span>CSV · Excel · Word</span></div>
          <ContactImportForm />
        </section>

        <section className={styles.panel} aria-labelledby="batches-heading">
          <div className={styles.panelHeading}><h2 id="batches-heading">Uploads</h2></div>
          {batches.length ? <ul className={styles.rowList}>{batches.map((batch) => <li key={batch.id}>
            <Link className={styles.row} href={`/dashboard/contacts/imports/${batch.id}`}>
              <span className={styles.rowMain}><strong>{batch.file_name}</strong><small>{batch.accepted_rows} added · {batch.rejected_rows} skipped</small></span>
              <span className={styles.rowSide}><small>{dateLabel(batch.created_at).slice(0, 10)}</small><ChevronRight size={18} aria-hidden="true" /></span>
            </Link>
          </li>)}</ul> : <p className={styles.empty}>{storageReady ? "No files uploaded yet." : "Uploads appear after setup."}</p>}
          {storageReady && <Pagination page={batchPage} total={batchResult?.count ?? 0} pageSize={BATCHES_SIZE} param="bp" path="/dashboard/contacts" label="Upload pages" />}
        </section>
      </div>
    </DashboardShell>
  );
}
