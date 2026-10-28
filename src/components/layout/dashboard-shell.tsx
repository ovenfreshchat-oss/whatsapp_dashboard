import type { ReactNode } from "react";
import { signOut } from "@/server/auth/actions";
import { FeedbackProvider } from "@/components/ui/feedback";
import { Brand } from "./brand";
import { NavLinks } from "./nav-links";
import { SignOutButton } from "./sign-out-button";
import styles from "./dashboard-shell.module.css";

type DashboardShellProps = {
  /** Admin-only sections: team and WhatsApp setup. */
  isAdmin?: boolean;
  /** Admin or staff: contacts, campaigns, inbox. */
  canWork?: boolean;
  email?: string | null;
  children: ReactNode;
};

/**
 * The app frame: Ink sidebar on desktop, icon rail on tablets, top bar and bottom tabs on phones.
 * It is rendered once by the dashboard layout, so it stays mounted while pages change.
 */
export function DashboardShell({ isAdmin = false, canWork = false, email, children }: DashboardShellProps) {
  const initial = (email ?? "S").trim().charAt(0).toUpperCase();
  return (
    <div className={styles.page}>
      <header className={styles.topNav}>
        <div className={styles.topNavInner}>
          <Brand compact tone="dark" className={styles.navBrand} />
          <nav className={styles.navigation} aria-label="Main navigation">
            <NavLinks isAdmin={isAdmin} canWork={canWork} />
          </nav>
          <div className={styles.headerActions}>
            {email && <div className={styles.account} title={email}>
              <span className={styles.avatar} aria-hidden="true">{initial}</span>
              <span className={styles.accountText}><strong>{isAdmin ? "Admin" : "Staff"}</strong><small>{email}</small></span>
            </div>}
            <form action={signOut}><SignOutButton /></form>
          </div>
        </div>
      </header>
      <main className={styles.workspace} id="main">
        <FeedbackProvider>{children}</FeedbackProvider>
      </main>
    </div>
  );
}
