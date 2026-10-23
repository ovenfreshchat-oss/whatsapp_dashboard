import type { Metadata } from "next";
import Link from "next/link";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { AddOptOutForm, ReleaseOptOutButton } from "./opt-out-forms";
import styles from "../contacts/contacts.module.css";

export const metadata: Metadata = {
  title: "Opt-out list | The Oven Fresh",
  description: "Phone numbers that must never receive campaign messages.",
};

type OptOut = { id: string; phone_e164: string; source: string; created_at: string };

export default async function OptOutsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const rawQuery = (await searchParams).q;
  const search = typeof rawQuery === "string" ? rawQuery.trim() : "";
  const phoneSearch = search.replace(/[^+\d]/g, "").slice(0, 20);
  const admin = createStaffAdminClient();
  const [countResult, listResult] = admin
    ? await Promise.all([
        admin.from("opt_out_numbers").select("id", { count: "exact", head: true }).is("released_at", null),
        admin.from("opt_out_numbers").select("id,phone_e164,source,created_at").is("released_at", null)
          .ilike("phone_e164", phoneSearch ? `%${phoneSearch}%` : "%")
          .order("created_at", { ascending: false }).limit(100),
      ])
    : [null, null];
  const ready = Boolean(countResult && !countResult.error && listResult && !listResult.error);
  const rows = (ready ? listResult?.data ?? [] : []) as OptOut[];

  return (
    <DashboardShell label="Contacts opt-outs" showMetaSetup>
      <div className={styles.content}>
        <Link href="/dashboard/contacts" className={styles.backLink}>← Back to contacts</Link>
        <div className={styles.intro}>
          <div><span className={styles.eyebrow}>AUDIENCE / OPT-OUTS</span><h1>Opt-out list<span>.</span></h1>
            <p>Numbers here are removed from every campaign when it is created and checked again right before each message is sent.</p></div>
          <span className={styles.countPill}>{ready ? `${countResult?.count ?? 0} opted out` : "Database setup needed"}</span>
        </div>
        {!ready && <section className={styles.notice}><strong>Apply the opt-out migration</strong><p>Run <code>drizzle/0010_opt_out_numbers.sql</code> in Supabase to enable this list.</p></section>}

        <section className={styles.panel} aria-labelledby="add-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>ADD</span><h2 id="add-heading">Add numbers</h2></div></div>
          <AddOptOutForm />
        </section>

        <section className={styles.panel} aria-labelledby="list-heading">
          <div className={styles.panelHeading}><div><span className={styles.eyebrow}>LIST</span><h2 id="list-heading">Opted-out numbers</h2></div><span>{phoneSearch ? "Search results" : "Latest 100"}</span></div>
          <form action="/dashboard/opt-outs" className={styles.searchForm}><label className={styles.field}><span>Search by phone number</span><input name="q" defaultValue={search} placeholder="+91…" maxLength={30} /></label><button className={styles.secondaryButton} type="submit">Search</button></form>
          {rows.length ? <div className={styles.tableWrap}><table><thead><tr><th>Number</th><th>Source</th><th>Added</th><th></th></tr></thead><tbody>
            {rows.map((row) => <tr key={row.id}><td>{row.phone_e164}</td><td>{row.source}</td><td>{row.created_at.slice(0, 16).replace("T", " ")} UTC</td><td><ReleaseOptOutButton id={row.id} /></td></tr>)}
          </tbody></table></div> : <p className={styles.empty}>{ready ? "No opted-out numbers." : "Apply the migration to view the list."}</p>}
        </section>
      </div>
    </DashboardShell>
  );
}
