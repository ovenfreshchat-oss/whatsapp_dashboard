/** How long chat history is kept before the daily cleanup removes it. */
export const DEFAULT_INBOX_RETENTION_DAYS = 90;
const MIN_DAYS = 31; // the database refuses anything closer than 30 days
const MAX_DAYS = 3650;

/** INBOX_RETENTION_DAYS, falling back to 90 when unset or invalid. */
export function parseRetentionDays(value: string | undefined): number {
  const days = Number(value?.trim());
  return Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS ? days : DEFAULT_INBOX_RETENTION_DAYS;
}

/** Messages older than this instant are deleted. */
export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Constant-time check of "Bearer <secret>" so the cron route cannot be called by anyone else. */
export function isAuthorizedCron(header: string | null, secret: string | undefined, equal: (a: string, b: string) => boolean): boolean {
  if (!secret || secret.length < 16 || !header) return false;
  return equal(header, `Bearer ${secret}`);
}
