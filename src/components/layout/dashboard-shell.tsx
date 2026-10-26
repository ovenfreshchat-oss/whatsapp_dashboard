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
    <main className={styles.page}>
      <section className={styles.shell} aria-label={label}>
        <aside className={styles.sidebar} aria-label="Workspace navigation">
          <div className={styles.brandWrap}>
            <Brand compact showTagline={false} className={styles.sidebarBrand} />
            {/* Mobile only: sign out lives in the app bar next to the brand. */}
            <form action={signOut} className={styles.appBarSignOutForm}>
              <button type="submit" className={styles.appBarSignOut} aria-label="Sign out" title="Sign out"><LogOut size={18} strokeWidth={2} aria-hidden="true" /></button>
            </form>
          </div>
          <nav className={styles.navigation} aria-label="Main navigation">
            <span className={styles.navCaption}>WORKSPACE</span>
            <NavLinks showAdminLinks={showMetaSetup} />
          </nav>
          <div className={styles.sidebarFooter}>
            <span className={styles.footerSparkle} aria-hidden="true">✦</span>
            <span>More tools coming soon</span>
          </div>
        </aside>

        <div className={styles.workspace}>
          <header className={[styles.topbar, headerAction ? "" : styles.topbarEmptyMobile].filter(Boolean).join(" ")}>
            <div className={styles.topbarTitle}>
              <span className={styles.topbarDot} aria-hidden="true" />
              <span>Campaign workspace</span>
            </div>
            <div className={styles.headerActions}>
              {headerAction}
              <form action={signOut} className={styles.desktopSignOutForm}><button type="submit" className={styles.signOut} aria-label="Sign out" title="Sign out"><LogOut size={18} strokeWidth={2} aria-hidden="true" /></button></form>
            </div>
          </header>
          {children}
        </div>
      </section>
    </main>
  );
}
