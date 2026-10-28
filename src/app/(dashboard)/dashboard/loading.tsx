import ui from "@/components/ui/ui.module.css";
import styles from "./loading.module.css";

/**
 * Shown inside the persistent frame while the next page loads on the server.
 * Only the content area is replaced; the sidebar never disappears.
 */
export default function DashboardLoading() {
  return (
    <div className={styles.content} aria-busy="true" aria-label="Loading">
      <div className={styles.head}>
        <span className={`${ui.skeleton} ${styles.title}`} />
        <span className={`${ui.skeleton} ${styles.bar} ${styles.line}`} />
      </div>
      <div className={styles.cards}>
        {[0, 1, 2, 3].map((index) => <div key={index} className={`${ui.skeleton} ${styles.card}`} />)}
      </div>
      <div className={`${ui.skeleton} ${styles.panel}`} />
      <div className={`${ui.skeleton} ${styles.panel} ${styles.tall}`} />
    </div>
  );
}
