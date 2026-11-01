/** Senior's rule: max 3 retries, never immediate. Defaults are 24 hours, 72 hours and 7 days. */
export const DEFAULT_RETRY_DELAYS_HOURS: readonly [number, number, number] = [24, 72, 168];
export const MAX_RETRY_ATTEMPTS = 3;
export const MAX_RETRY_DELAY_HOURS = 720;

export type RetryDelaysResult =
  | { ok: true; delays: [number, number, number] }
  | { ok: false; error: string };

/** Validates the three delay inputs (hours). They must be whole numbers that strictly increase. */
export function parseRetryDelays(values: readonly unknown[]): RetryDelaysResult {
  if (values.length !== MAX_RETRY_ATTEMPTS) {
    return { ok: false, error: "Enter a delay in hours for each of the 3 retries." };
  }
  const delays: number[] = [];
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^\d{1,4}$/.test(text)) {
      return { ok: false, error: "Delays must be whole numbers of hours, for example 24, 72 and 168." };
    }
    delays.push(Number(text));
  }
  if (delays[0] < 1) return { ok: false, error: "The first retry must wait at least 1 hour." };
  if (delays[0] >= delays[1] || delays[1] >= delays[2]) {
    return { ok: false, error: "Each retry must wait longer than the one before it." };
  }
  if (delays[2] > MAX_RETRY_DELAY_HOURS) {
    return { ok: false, error: `The last retry can wait at most ${MAX_RETRY_DELAY_HOURS} hours (30 days).` };
  }
  return { ok: true, delays: delays as [number, number, number] };
}

/** "24 hours", "3 days", "7 days": a short label for a delay. */
export function describeDelay(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** CSV cell that cannot run as a spreadsheet formula and is always quoted. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
