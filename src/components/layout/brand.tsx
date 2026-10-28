import Image from "next/image";
import styles from "./brand.module.css";

type BrandProps = {
  compact?: boolean;
  /** Small "Powered by Solalyn" line under the name. */
  showPoweredBy?: boolean;
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

/** The Solalyn logo: dot-and-curve mark plus wordmark. "Sol" follows the text colour, "alyn" is always coral. */
export function SolalynWordmark({ className = "" }: { className?: string }) {
  return (
    <span className={[styles.wordmark, className].filter(Boolean).join(" ")} role="img" aria-label="Solalyn">
      <svg viewBox="0 0 30 30" width="13" height="13" aria-hidden="true" focusable="false">
        <circle cx="6" cy="23.5" r="4.4" fill="#F74932" />
        <path d="M10 21.6c4.6-.8 7-3.6 4-6.6-2.4-2.4-.2-5.6 4.4-6.3" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <circle cx="23" cy="7.2" r="3" fill="none" stroke="currentColor" strokeWidth="1.9" />
      </svg>
      <span className={styles.wordmarkText} aria-hidden="true">Sol<em>alyn</em></span>
    </span>
  );
}

/** The Oven Fresh logo is the main brand; Solalyn appears only as a small credit line. */
export function Brand({ compact = false, showPoweredBy = true, tone = "light", className = "" }: BrandProps) {
  const size = compact ? 36 : 44;
  return (
    <div className={[styles.brand, compact ? styles.compact : "", tone === "dark" ? styles.dark : "", className].filter(Boolean).join(" ")}>
      <Image src="/icons/oven-fresh-logo.png" alt="The Oven Fresh" width={size} height={size} priority className={styles.logo} />
      <span className={styles.text}>
        <strong>The Oven Fresh</strong>
        {showPoweredBy && <small className={styles.powered}>
          <span>Powered by</span>
          <SolalynWordmark />
        </small>}
      </span>
    </div>
  );
}
