import type { ReactNode } from "react";
import styles from "./badges.module.css";

export type MessageCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";

const CATEGORY: Record<MessageCategory, { label: string; className: string }> = {
  MARKETING: { label: "Marketing", className: styles.marketing },
  UTILITY: { label: "Utility", className: styles.utility },
  AUTHENTICATION: { label: "Authentication", className: styles.authentication },
};

/** Normalises whatever Meta or the database returns into one of the three categories. */
export function toCategory(value: string | null | undefined): MessageCategory | null {
  const upper = String(value ?? "").toUpperCase();
  if (upper.startsWith("MARKETING")) return "MARKETING";
  if (upper === "UTILITY") return "UTILITY";
  if (upper.startsWith("AUTHENTICATION")) return "AUTHENTICATION";
  return null;
}

/** Marketing is violet, Utility is teal, Authentication is gold, on every screen. */
export function CategoryBadge({ category }: { category: string | null | undefined }) {
  const key = toCategory(category);
  if (!key) return <span className={`${styles.badge} ${styles.neutral}`}>{category ? String(category).toLowerCase() : "Unknown"}</span>;
  const item = CATEGORY[key];
  return <span className={`${styles.badge} ${item.className}`}><i aria-hidden="true" />{item.label}</span>;
}

export type Tone = "neutral" | "success" | "danger" | "warning" | "info" | "live";

export function StatusPill({ tone = "neutral", children, dot = true }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{dot && <i aria-hidden="true" />}{children}</span>;
}

const STATE_TONE: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  scheduled: { tone: "info", label: "Scheduled" },
  running: { tone: "live", label: "Sending" },
  paused: { tone: "warning", label: "Paused" },
  canceled: { tone: "danger", label: "Canceled" },
  completed: { tone: "success", label: "Completed" },
};

export function CampaignStateBadge({ state }: { state: string }) {
  const item = STATE_TONE[state] ?? { tone: "neutral" as Tone, label: state };
  return <StatusPill tone={item.tone}>{item.label}</StatusPill>;
}
