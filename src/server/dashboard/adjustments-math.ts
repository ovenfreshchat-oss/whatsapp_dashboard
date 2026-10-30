export const ADJUSTMENT_METRICS = ["messages_sent", "messages_delivered", "marketing", "utility", "authentication"] as const;
export type AdjustmentMetric = (typeof ADJUSTMENT_METRICS)[number];
export type MetricAdjustments = Record<AdjustmentMetric, number>;

export const MAX_METRIC_TOTAL = 100_000_000;

export const emptyAdjustments = (): MetricAdjustments => ({
  messages_sent: 0, messages_delivered: 0, marketing: 0, utility: 0, authentication: 0,
});

export type ParsedTotal = { kind: "blank" } | { kind: "ok"; total: number } | { kind: "invalid" };

/** A blank box means "no adjustment". Only whole, non-negative numbers are accepted (commas and spaces are fine). */
export function parseMetaTotal(raw: unknown): ParsedTotal {
  if (typeof raw !== "string") return { kind: "invalid" };
  const text = raw.replace(/[,\s]/g, "");
  if (text === "") return { kind: "blank" };
  if (!/^\d{1,9}$/.test(text)) return { kind: "invalid" };
  const total = Number(text);
  return total > MAX_METRIC_TOTAL ? { kind: "invalid" } : { kind: "ok", total };
}

/**
 * Adjustment to store so that database count + adjustment equals Meta's total.
 * Returns null when Meta's total is lower than what the database already counted.
 */
export function offsetFromMetaTotal(metaTotal: number, databaseCount: number): number | null {
  return metaTotal >= databaseCount ? metaTotal - databaseCount : null;
}
