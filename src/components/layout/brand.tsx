import styles from "./brand.module.css";

type BrandProps = {
  compact?: boolean;
  showTagline?: boolean;
  /** "dark" is for the Ink sidebar; "light" for white and sand surfaces. */
  tone?: "dark" | "light";
  className?: string;
};

/** The Solalyn mark. Inline SVG, so it is crisp at any size and needs no extra request. */
export function SolalynMark({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect width="40" height="40" rx="11" fill="#F74932" />
      <path d="M26.2 14.2c-1.2-2.2-3.4-3.4-6.1-3.4-3.3 0-5.6 1.8-5.6 4.4 0 6.4 11.8 3.2 11.8 9.5 0 2.8-2.7 4.6-6.2 4.6-2.9 0-5.4-1.3-6.6-3.7" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="31.5" cy="9" r="3.6" fill="#25D366" stroke="#F74932" strokeWidth="1.8" />
    </svg>
  );
}

export function Brand({ compact = false, showTagline = true, tone = "light", className = "" }: BrandProps) {
  return (
    <div className={[styles.brand, compact ? styles.compact : "", tone === "dark" ? styles.dark : "", className].filter(Boolean).join(" ")}>
      <SolalynMark size={compact ? 36 : 44} className={styles.mark} />
      <span className={styles.text}>
        <strong>Solalyn</strong>
        {showTagline && <small>WhatsApp Business</small>}
      </span>
    </div>
  );
}
