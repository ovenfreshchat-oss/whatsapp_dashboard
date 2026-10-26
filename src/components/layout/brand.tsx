import styles from "./brand.module.css";

type BrandProps = {
  compact?: boolean;
  showTagline?: boolean;
  className?: string;
};

export function Brand({ compact = false, showTagline = true, className = "" }: BrandProps) {
  return (
    <div className={[styles.brand, compact ? styles.compact : "", className].filter(Boolean).join(" ")}>
      <span className={styles.mark} aria-hidden="true">
        <img src="/icons/oven-fresh-logo.png" alt="" width={256} height={256} />
      </span>
      <span className={styles.text}>
        <strong>The Oven Fresh</strong>
        {showTagline && <small>CAMPAIGN WORKSPACE</small>}
      </span>
    </div>
  );
}
