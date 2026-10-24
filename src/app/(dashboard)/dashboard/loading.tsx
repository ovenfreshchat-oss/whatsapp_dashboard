import { DashboardShell } from "@/components/layout/dashboard-shell";
import styles from "./loading.module.css";

/** Shown the instant a sidebar link is clicked, while the next page loads on the server. */
export default function DashboardLoading() {
  return (
    <DashboardShell label="Loading" showMetaSetup>
      <div className={styles.content} aria-busy="true" aria-label="Loading">
        <span className={`${styles.bar} ${styles.small}`} />
        <span className={`${styles.bar} ${styles.title}`} />
        <span className={`${styles.bar} ${styles.line}`} />
        <div className={styles.cards}>
          {[0, 1, 2, 3].map((index) => <div key={index} className={`${styles.card} ${styles.block}`} />)}
        </div>
        <div className={`${styles.panel} ${styles.block}`} />
        <div className={`${styles.panel} ${styles.tall} ${styles.block}`} />
      </div>
    </DashboardShell>
  );
}
