import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";
import { getCategoryVolumes } from "@/server/campaigns/pricing";
import { createStaffAdminClient, isStaffAdminEmail } from "@/server/auth/staff-users/admin";
import styles from "./dashboard.module.css";

export const metadata: Metadata = {
  title: "Dashboard | The Oven Fresh",
};

type IconName = "contacts" | "templates" | "campaigns" | "team";

function MetricIcon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {name === "contacts" && (
        <>
          <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.7" />
          <path d="M3.7 19v-1.2A5.3 5.3 0 0 1 9 12.5h.1a5.3 5.3 0 0 1 5.2 5.3V19H3.7ZM17 6.5a2.5 2.5 0 0 1 0 5M16.7 14a4 4 0 0 1 3.6 4v1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {name === "templates" && (
        <>
          <rect x="4" y="3.5" width="16" height="17" rx="3" stroke="currentColor" strokeWidth="1.7" />
          <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      )}
      {name === "campaigns" && (
        <>
          <path d="m4 10 11-5v14L4 14v-4ZM15 8.5l4.2-1.8v10.6L15 15.5M7 15.4l1.3 4.1h3" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
        </>
      )}
      {name === "team" && (
        <>
          <rect x="4.5" y="10" width="15" height="10.5" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) redirect("/sign-in");

  const user = data.user;
  const canAddStaff = Boolean(user.email_confirmed_at && isStaffAdminEmail(user.email));
  if (user.app_metadata?.role !== "staff" && !canAddStaff) redirect("/access-denied");

  const email = user.email ?? "Staff member";
  const metaSettingsPresent = [
    process.env.META_GRAPH_API_VERSION,
    process.env.META_WABA_ID,
    process.env.META_PHONE_NUMBER_ID,
    process.env.META_SYSTEM_USER_ACCESS_TOKEN,
    process.env.META_APP_SECRET,
    process.env.META_WEBHOOK_VERIFY_TOKEN,
  ].every(Boolean);
  const admin = canAddStaff ? createStaffAdminClient() : null;
  const [contactsResult, campaignsResult, activeResult, sentResult, optOutResult, repliesResult, categories] = admin
    ? await Promise.all([
        admin.from("contacts").select("id", { count: "exact", head: true }),
        admin.from("whatsapp_campaigns").select("id", { count: "exact", head: true }),
        admin.from("whatsapp_campaigns").select("id", { count: "exact", head: true })
          .in("state", ["scheduled", "running", "paused"]),
        admin.from("whatsapp_campaign_recipients").select("id", { count: "exact", head: true })
          .eq("state", "accepted"),
        admin.from("opt_out_numbers").select("phone_e164", { count: "exact", head: true }),
        admin.from("inbox_messages").select("id", { count: "exact", head: true })
          .eq("direction", "outbound").in("status", ["sent", "delivered", "read"]),
        getCategoryVolumes(),
      ])
    : [null, null, null, null, null, null, null];
  const count = (result: { count: number | null; error: unknown } | null) =>
    result && !result.error ? (result.count ?? 0) : null;
  const contactCount = count(contactsResult);
  const show = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US"));
  const campaignSent = count(sentResult);
  const replySent = count(repliesResult);
  const totalSent = campaignSent === null ? null : campaignSent + (replySent ?? 0);
  const metaNote = categories ? "Delivered, per Meta (12 months)" : "Not available from Meta yet";
  const metrics: { label: string; value: string; detail: string; icon: IconName }[] = [
    { label: "Campaigns", value: show(count(campaignsResult)),
      detail: count(campaignsResult) === null ? "Database setup needed" : `${count(activeResult) ?? 0} active now`, icon: "campaigns" },
    { label: "Messages sent", value: show(totalSent), detail: "Campaigns and inbox replies", icon: "templates" },
    { label: "Contacts", value: show(contactCount),
      detail: contactCount === null ? "Database setup needed" : "Saved numbers", icon: "contacts" },
    { label: "Opted out", value: show(count(optOutResult)), detail: "Never messaged", icon: "team" },
    { label: "Marketing messages", value: show(categories ? categories.marketing : campaignSent),
      detail: categories ? metaNote : "Sent from campaigns", icon: "campaigns" },
    { label: "Utility messages", value: show(categories ? categories.utility : null), detail: metaNote, icon: "templates" },
    { label: "Authentication messages", value: show(categories ? categories.authentication : null), detail: metaNote, icon: "team" },
  ];
  const readySteps = 1 + (contactCount ? 1 : 0) + (metaSettingsPresent ? 1 : 0);

  return (
    <DashboardShell
      label="The Oven Fresh dashboard"
      headerAction={canAddStaff && <Link className={styles.addUserLink} href="/dashboard/users/new">Add staff user <span aria-hidden="true">↗</span></Link>}
      showMetaSetup={canAddStaff}
    >
      <div className={styles.content}>
        <div className={styles.headingRow}>
          <div>
            <span className={styles.eyebrow}>WORKSPACE OVERVIEW</span>
            <h1>Dashboard overview</h1>
            <p>Your contacts, campaigns, and team in one place.</p>
          </div>
          <span className={styles.activeBadge}><i aria-hidden="true" /> Workspace active</span>
        </div>

        <section className={styles.metrics} aria-label="Workspace metrics">
          {metrics.map((metric) => (
            <article className={styles.metricCard} key={metric.label}>
              <div className={styles.metricTop}>
                <span>{metric.label}</span>
                <span className={styles.metricIcon}><MetricIcon name={metric.icon} /></span>
              </div>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
            </article>
          ))}
        </section>

        <section className={styles.systems} aria-label="Connection status">
          <article className={styles.systemCard}>
            <span className={styles.systemMark}>✦</span>
            <div><strong>Identity</strong><small>Staff email and password</small></div>
            <span className={styles.ready}>Connected</span>
          </article>
          <article className={styles.systemCard}>
            <span className={styles.systemMark}>◈</span>
            <div><strong>Team onboarding</strong><small>Direct account creation</small></div>
            <span className={styles.ready}>{canAddStaff ? "Admin ready" : "Admin only"}</span>
          </article>
          <article className={styles.systemCard}>
            <span className={styles.systemMark}>◎</span>
            <div><strong>WhatsApp API</strong><small>{canAddStaff ? <Link href="/dashboard/meta">View Meta setup</Link> : "Admin setup"}</small></div>
            <span className={metaSettingsPresent ? styles.ready : styles.pending}>{metaSettingsPresent ? "Check connection" : "Setup needed"}</span>
          </article>
        </section>

        <section className={styles.lowerGrid} aria-label="Workspace setup and access">
          <article className={styles.setupPanel}>
            <div className={styles.panelHeading}>
              <div>
                <h2>Workspace setup</h2>
                <p>Build the foundation for your first campaign.</p>
              </div>
              <span>{readySteps} of 3 ready</span>
            </div>
            <ol className={styles.setupSteps}>
              <li className={styles.completeStep}>
                <span className={styles.stepNumber}>01</span>
                <span className={styles.stepCopy}><strong>Staff sign-in</strong><small>Secure access through Supabase Auth is connected.</small></span>
                <span className={styles.stepState}>Connected</span>
              </li>
              <li className={contactCount ? styles.completeStep : undefined}>
                <span className={styles.stepNumber}>02</span>
                <span className={styles.stepCopy}><strong>Contacts</strong><small>{canAddStaff ? <Link href="/dashboard/contacts">{contactCount ? `${contactCount} numbers saved. Upload more.` : "Upload a CSV of phone numbers."}</Link> : "A workspace admin can import contacts."}</small></span>
                <span className={styles.stepState}>{contactCount ? "Ready" : "Next"}</span>
              </li>
              <li className={metaSettingsPresent ? styles.completeStep : undefined}>
                <span className={styles.stepNumber}>03</span>
                <span className={styles.stepCopy}><strong>WhatsApp connection</strong><small>{canAddStaff ? <Link href="/dashboard/meta">Review account, templates, and webhook status.</Link> : "A workspace admin can review the Meta connection."}</small></span>
                <span className={styles.stepState}>{metaSettingsPresent ? "Connected" : "Set up"}</span>
              </li>
            </ol>
          </article>

          <aside className={styles.accessPanel}>
            <div className={styles.panelHeading}>
              <div>
                <h2>Team access</h2>
                <p>Your account and workspace status</p>
              </div>
            </div>
            <div className={styles.progressRing} style={{ "--pct": `${Math.round((readySteps / 3) * 100)}%` } as CSSProperties} aria-label={`${readySteps} of three setup steps are ready`}>
              <div><strong>{readySteps} / 3</strong><span>ready</span></div>
            </div>
            <div className={styles.accountInfo}>
              <span>Signed in as</span>
              <strong>{email}</strong>
              <small>{canAddStaff ? "Workspace admin" : "Staff member"}</small>
            </div>
          </aside>
        </section>
      </div>
    </DashboardShell>
  );
}
