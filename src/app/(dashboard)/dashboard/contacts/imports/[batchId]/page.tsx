import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/ui/back-link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Pagination, pageFrom } from "@/components/ui/pagination";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { ActiveSwitch, BatchActiveButtons } from "../../number-switch";
import styles from "../../contacts.module.css";

export const metadata: Metadata = { title: "Upload | The Oven Fresh" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NumberRow = { id: string; phone_e164: string; display_name: string | null; campaign_active: boolean };
const NUMBERS_SIZE = 25;

function dayLabel(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toISOString().slice(0, 10);
}

export default async function UploadNumbersPage({ params, searchParams }: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ np?: string | string[]; q?: string | string[] }>;
}) {
  const { batchId } = await params;
  if (!UUID.test(batchId)) notFound();
  const query = await searchParams;
  const numbersPage = pageFrom(query.np);
  const rawSearch = Array.isArray(query.q) ? query.q[0] : query.q;
  const search = (rawSearch ?? "").replace(/[^\p{L}\p{N}+ .'-]/gu, "").trim().slice(0, 40);
  const searchDigits = search.replace(/[^+\d]/g, "");
  // Match a name, or a phone number typed in any format.
  const searchFilter = search
    ? [`display_name.ilike.%${search}%`, searchDigits.length >= 2 ? `phone_e164.ilike.%${searchDigits}%` : null].filter(Boolean).join(",")
    : "";

  const admin = createStaffAdminClient();
  if (!admin) throw new Error("The contact database is unavailable.");
  const first = (numbersPage - 1) * NUMBERS_SIZE;
  const base = admin.from("contacts")
    .select("id,phone_e164,display_name,campaign_active,contact_batch_members!inner(batch_id)", { count: "exact" })
    .eq("contact_batch_members.batch_id", batchId);
  const [batchResult, numbersResult, inactiveResult] = await Promise.all([
    admin.from("contact_import_batches").select("id,file_name,created_at").eq("id", batchId).single(),
    (searchFilter ? base.or(searchFilter) : base).order("phone_e164").range(first, first + NUMBERS_SIZE - 1),
    admin.from("contacts")
      .select("id,contact_batch_members!inner(batch_id)", { count: "exact", head: true })
      .eq("contact_batch_members.batch_id", batchId).eq("campaign_active", false),
  ]);
  if (batchResult.error || !batchResult.data) notFound();
  const batch = batchResult.data;
  const numbersReady = !numbersResult.error && !inactiveResult.error;
  const numberRows = (numbersReady ? numbersResult.data ?? [] : []) as NumberRow[];
  const totalNumbers = numbersResult.count ?? 0;
  const inactiveNumbers = inactiveResult.count ?? 0;
  const optOutResult = numberRows.length
    ? await admin.from("opt_out_numbers").select("phone_e164")
        .in("phone_e164", numberRows.map((row) => row.phone_e164)).is("released_at", null)
    : null;
  const optedOut = new Set((optOutResult?.data ?? []).map((row: { phone_e164: string }) => row.phone_e164));
  const path = `/dashboard/contacts/imports/${batchId}`;

  return <DashboardShell label="Contacts · upload" showMetaSetup><div className={styles.content}>
    <BackLink href="/dashboard/contacts">Uploads</BackLink>
    <div className={styles.pageHead}>
      <div><h1 className={styles.fileTitle}>{batch.file_name}</h1><p className={styles.muted}>Uploaded {dayLabel(batch.created_at)}</p></div>
    </div>

    <section className={styles.panel} aria-label="Numbers in this upload">
      {!numbersReady ? <p className={styles.empty}>Numbers could not be loaded. Apply <code>drizzle/0020_contact_campaign_active.sql</code> and refresh.</p> : <>
        <form action={path} className={styles.searchForm} role="search">
          <label className={styles.searchBox}><Search size={18} aria-hidden="true" /><input name="q" defaultValue={search} placeholder="Search by number or name" maxLength={40} aria-label="Search numbers in this upload" /></label>
          <button className={styles.button} type="submit">Search</button>
          {search && <Link href={path} className={styles.secondaryButton}>Clear</Link>}
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
        <Pagination page={numbersPage} total={totalNumbers} pageSize={NUMBERS_SIZE} param="np" path={path} query={{ q: search || undefined }} label="Number pages" />
      </>}
    </section>
  </div></DashboardShell>;
}
