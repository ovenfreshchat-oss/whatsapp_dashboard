import type { ReactNode } from "react";
import Link from "next/link";
import { signOut } from "@/server/auth/actions";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Brand } from "./brand";
import styles from "./dashboard-shell.module.css";

type DashboardShellProps = {
  label: string;
  headerAction?: ReactNode;
  showMetaSetup?: boolean;
  children: ReactNode;
};

const upcomingSections: { icon: string; label: string }[] = [];

export function DashboardShell({ label, headerAction, showMetaSetup = false, children }: DashboardShellProps) {
  const dashboardIsCurrent = label === "The Oven Fresh dashboard";
  const metaIsCurrent = label === "WhatsApp integration";
  const contactsIsCurrent = label.startsWith("Contacts");
  const campaignsIsCurrent = /campaign/i.test(label);
  const inboxIsCurrent = label === "WhatsApp inbox";

  return (
    <main className={styles.page}>
      <section className={styles.shell} aria-label={label}>
        <aside className={styles.sidebar} aria-label="Workspace navigation">
          <div className={styles.brandWrap}><Brand compact showTagline={false} className={styles.sidebarBrand} /></div>
          <nav className={styles.navigation} aria-label="Main navigation">
            <span className={styles.navCaption}>WORKSPACE</span>
            <Link
              href="/dashboard"
              className={[styles.navItem, dashboardIsCurrent ? styles.navItemActive : ""].filter(Boolean).join(" ")}
              aria-current={dashboardIsCurrent ? "page" : undefined}
            >
              <span className={styles.navIcon} aria-hidden="true">⌂</span>
              <span>Dashboard</span>
            </Link>
            {showMetaSetup && (
              <Link
                href="/dashboard/contacts"
                className={[styles.navItem, contactsIsCurrent ? styles.navItemActive : ""].filter(Boolean).join(" ")}
                aria-current={contactsIsCurrent ? "page" : undefined}
              >
                <span className={styles.navIcon} aria-hidden="true">◎</span>
                <span>Contacts</span>
              </Link>
            )}
            {showMetaSetup && (
              <Link
                href="/dashboard/campaigns"
                className={[styles.navItem, campaignsIsCurrent ? styles.navItemActive : ""].filter(Boolean).join(" ")}
                aria-current={campaignsIsCurrent ? "page" : undefined}
              >
                <span className={styles.navIcon} aria-hidden="true">▦</span>
                <span>Campaigns</span>
              </Link>
            )}
            {showMetaSetup && (
              <Link
                href="/dashboard/inbox"
                className={[styles.navItem, inboxIsCurrent ? styles.navItemActive : ""].filter(Boolean).join(" ")}
                aria-current={inboxIsCurrent ? "page" : undefined}
              >
                <span className={styles.navIcon} aria-hidden="true">✉</span>
                <span>Inbox</span>
              </Link>
            )}
            {upcomingSections.map((section) => (
              <span className={styles.navItemMuted} key={section.label}>
                <span className={styles.navIcon} aria-hidden="true">{section.icon}</span>
                <span>{section.label}</span>
              </span>
            ))}
            {showMetaSetup && (
              <Link
                href="/dashboard/meta"
                className={[styles.navItem, metaIsCurrent ? styles.navItemActive : ""].filter(Boolean).join(" ")}
                aria-current={metaIsCurrent ? "page" : undefined}
              >
                <span className={styles.navIcon} aria-hidden="true">⚙</span>
                <span className={styles.labelFull}>WhatsApp setup</span><span className={styles.labelShort}>Setup</span>
              </Link>
            )}
          </nav>
          <div className={styles.sidebarFooter}>
            <span className={styles.footerSparkle} aria-hidden="true">✦</span>
            <span>More tools coming soon</span>
          </div>
        </aside>

        <div className={styles.workspace}>
          <header className={styles.topbar}>
            <div className={styles.topbarTitle}>
              <span className={styles.topbarDot} aria-hidden="true" />
              <span>Campaign workspace</span>
            </div>
            <div className={styles.headerActions}>
              <StatusBadge>STAFF WORKSPACE</StatusBadge>
              {headerAction}
              <form action={signOut}><Button type="submit" variant="secondary">Sign out</Button></form>
            </div>
          </header>
          {children}
        </div>
      </section>
    </main>
  );
}
