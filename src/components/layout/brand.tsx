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
        <svg viewBox="0 0 48 48" fill="none" role="presentation">
          <path d="M10 31.5C10 23.5 16.3 17 24 17s14 6.5 14 14.5v5H10v-5Z" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M16 31h16M19 11.5c0-2 2-2.8 2-5M26 12.5c0-2 2-2.8 2-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="24" cy="25" r="1.7" fill="currentColor" />
        </svg>
      </span>
      <span className={styles.text}>
        <strong>The Oven Fresh</strong>
        {showTagline && <small>CAMPAIGN WORKSPACE</small>}
      </span>
    </div>
  );
}
