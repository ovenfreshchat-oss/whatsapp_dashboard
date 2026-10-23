import styles from "./status-badge.module.css";

export function StatusBadge({ children }: { children: string }) {
  return <span className={styles.badge}><span aria-hidden="true" />{children}</span>;
}
