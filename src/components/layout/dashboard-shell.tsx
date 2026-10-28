import type { ReactNode } from "react";
import { signOut } from "@/server/auth/actions";
import { FeedbackProvider } from "@/components/ui/feedback";
import { Brand } from "./brand";
import { NavLinks } from "./nav-links";
import { SignOutButton } from "./sign-out-button";
import styles from "./dashboard-shell.module.css";

type DashboardShellProps = {
  /** Shows the admin-only sections (contacts, campaigns, inbox, setup). */
  showMetaSetup?: boolean;
  email?: string | null;
  children: ReactNode;
};

/**
 * The app frame: Ink sidebar on desktop, icon rail on tablets, top bar and bottom tabs on phones.
 * It is rendered once by the dashboard layout, so it stays mounted while pages change.
 */
export function DashboardShell({ showMetaSetup = false, email, children }: DashboardShellProps) {
  const initial = (email ?? "S").trim().charAt(0).toUpperCase();
  return (
    <div className={styles.page}>
      <header className={styles.topNav}>
        <div className={styles.topNavInner}>
          <Brand compact showTagline={false} tone="dark" className={styles.navBrand} />
          <nav className={styles.navigation} aria-label="Main navigation">
            <NavLinks showAdminLinks={showMetaSetup} />
          </nav>
          <div className={styles.headerActions}>
            {email && <div className={styles.account} title={email}>
              <span className={styles.avatar} aria-hidden="true">{initial}</span>
              <span className={styles.accountText}><strong>{showMetaSetup ? "Admin" : "Staff"}</strong><small>{email}</small></span>
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
