import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Pagination, pageFrom } from "@/components/ui/pagination";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { formatDate, formatDateTime } from "@/lib/timezone";
import { ReactivateButton } from "@/app/(dashboard)/dashboard/campaigns/[campaignId]/failed-controls";
import styles from "../contacts.module.css";

export const metadata: Metadata = {
  title: "Failed Contacts | Solalyn",
  description: "Contacts that had failed WhatsApp messages: At Risk and Do Not Send.",
};

type Tab = "at_risk" | "do_not_send";
const PAGE_SIZE = 15;

const REASON: Record<string, string> = {
  meta_marketing_limit_131049: "Meta held a marketing message (131049)",
  repeated_131049: "Meta held messages in 3 or more campaigns (131049)",
  undeliverable_131026: "Number cannot receive messages (131026)",
  cooldown_131056: "Cooling down after a pair rate limit (131056)",
  retry_exhausted: "All retries failed",
};

type StatusRow = { contact_id: string; phone_e164: string; status: string; reason: string | null; hold_until: string | null; review_due_at: string | null };
type FailureRow = { phone_e164: string; error_code: string; error_title: string | null; failed_at: string; campaign_id: string };

export default async function FailedContactsPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[]; p?: string | string[] }> }) {
  const params = await searchParams;
  const rawTab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab: Tab = rawTab === "do_not_send" ? "do_not_send" : "at_risk";
  const page = pageFrom(params.p);
  const first = (page - 1) * PAGE_SIZE;
  const admin = createStaffAdminClient();

  const [counts, list] = admin
    ? await Promise.all([
        admin.rpc("contact_status_counts"),
        admin.from("contact_delivery_status")
          .select("contact_id,phone_e164,status,reason,hold_until,review_due_at", { count: "exact" })
          .eq("status", tab).order("phone_e164").range(first, first + PAGE_SIZE - 1),
      ])
    : [null, null];
  const ready = Boolean(list && !list.error);
  const rows = (ready ? list?.data ?? [] : []) as StatusRow[];
  const total = ready ? list?.count ?? 0 : 0;
  const summary = counts && !counts.error && counts.data && typeof counts.data === "object"
    ? counts.data as Partial<Record<Tab, number>> : {};

  const names = new Map<string, string>();
  const latest = new Map<string, FailureRow>();
  const campaigns = new Map<string, string>();
  if (admin && rows.length) {
    const [contacts, failures] = await Promise.all([
      admin.from("contacts").select("id,display_name").in("id", rows.map((row) => row.contact_id)),
      admin.from("contact_delivery_failures").select("phone_e164,error_code,error_title,failed_at,campaign_id")
        .in("phone_e164", rows.map((row) => row.phone_e164)).order("failed_at", { ascending: false }).limit(600),
    ]);
    for (const contact of contacts.data ?? []) if (contact.display_name) names.set(String(contact.id), String(contact.display_name));
    for (const failure of (failures.data ?? []) as FailureRow[]) if (!latest.has(failure.phone_e164)) latest.set(failure.phone_e164, failure);
    const ids = [...new Set([...latest.values()].map((failure) => failure.campaign_id))];
    if (ids.length) {
      const named = await admin.from("whatsapp_campaigns").select("id,name").in("id", ids);
      for (const campaign of named.data ?? []) campaigns.set(String(campaign.id), String(campaign.name));
    }
  }

  const tabs: { key: Tab; label: string; help: string }[] = [
    { key: "at_risk", label: "At Risk", help: "Meta held a marketing message (131049). These numbers are still messaged. Review them, and reactivate a number you know is fine." },
    { key: "do_not_send", label: "Do Not Send", help: "Paused from campaigns. A number returns after you review it, once its hold date has passed." },
  ];
  const current = tabs.find((item) => item.key === tab)!;

  return (
    <div className={styles.content}>
      <div className={styles.pageHead}>
        <h1>Failed Contacts</h1>
        <div className={styles.actions}>
          <Link href="/dashboard/contacts" className={styles.secondaryButton}><ArrowLeft size={16} aria-hidden="true" /> Contacts</Link>
          <Link href="/dashboard/campaigns" className={styles.secondaryButton}>Failed messages by campaign</Link>
        </div>
      </div>

      <section className={styles.panel} aria-label="Failed contacts">
        <div className={styles.tabs} role="tablist" aria-label="Failed contact status">
          {tabs.map((item) => (
            <Link key={item.key} role="tab" aria-selected={item.key === tab} scroll={false}
              href={item.key === "at_risk" ? "/dashboard/contacts/failed" : `/dashboard/contacts/failed?tab=${item.key}`}
              className={item.key === tab ? `${styles.tab} ${styles.tabActive}` : styles.tab}>
              {item.label}<span>{summary[item.key] ?? 0}</span>
            </Link>
          ))}
        </div>
        <p className={styles.tabHelp}>{current.help}</p>

        {!ready ? <p className={styles.empty}>Could not load this list. Check that drizzle/0025 and 0026 are applied.</p>
          : rows.length === 0 ? <p className={styles.empty}>No contacts are {current.label} right now.</p>
          : <div className={styles.tableWrap}>
              <table>
                <thead><tr><th>Contact</th><th>Why</th><th>Last failure</th><th>{tab === "do_not_send" ? "Review from" : "Status"}</th><th><span className="sr-only">Action</span></th></tr></thead>
                <tbody>
                  {rows.map((row) => {
                    const failure = latest.get(row.phone_e164);
                    const due = row.review_due_at ?? row.hold_until;
                    return <tr key={row.contact_id}>
                      <td><strong>{names.get(row.contact_id) ?? row.phone_e164}</strong>{names.has(row.contact_id) && <><br /><small>{row.phone_e164}</small></>}</td>
                      <td>{(row.reason && REASON[row.reason]) ?? row.reason ?? "—"}</td>
                      <td>{failure
                        ? <>{failure.error_code}{failure.error_title ? ` · ${failure.error_title}` : ""}<br /><small>{formatDateTime(failure.failed_at)}{campaigns.get(failure.campaign_id) ? ` · ${campaigns.get(failure.campaign_id)}` : ""}</small></>
                        : "—"}</td>
                      <td>{tab === "do_not_send" ? (due ? formatDate(due) : "Now") : "Still messaged"}</td>
                      <td><ReactivateButton phone={row.phone_e164} campaignId="" /></td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>}
        {ready && <Pagination page={page} total={total} pageSize={PAGE_SIZE} path="/dashboard/contacts/failed" query={{ tab: tab === "at_risk" ? undefined : tab }} param="p" label="Failed contact pages" />}
      </section>
    </div>
  );
}
