import type { ReactNode } from "react";
import { signOut } from "@/server/auth/actions";
import { LogOut } from "lucide-react";
import { Brand } from "./brand";
import { NavLinks } from "./nav-links";
import styles from "./dashboard-shell.module.css";

type DashboardShellProps = {
  label: string;
  headerAction?: ReactNode;
  showMetaSetup?: boolean;
  children: ReactNode;
};

export function DashboardShell({ label, headerAction, showMetaSetup = false, children }: DashboardShellProps) {
  return (
    <main className={styles.page} aria-label={label}>
      <header className={styles.topNav}>
        <div className={styles.topNavInner}>
          <Brand compact showTagline={false} className={styles.navBrand} />
          <nav className={styles.navigation} aria-label="Main navigation">
            <NavLinks showAdminLinks={showMetaSetup} />
          </nav>
          <div className={styles.headerActions}>
            {headerAction}
            <form action={signOut}>
              <button type="submit" className={styles.signOut} aria-label="Sign out" title="Sign out"><LogOut size={18} strokeWidth={2} aria-hidden="true" /></button>
            </form>
          </div>
        </div>
      </header>
      <div className={styles.workspace}>{children}</div>
    </main>
  );
}
