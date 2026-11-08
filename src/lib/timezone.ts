/**
 * One place for time zones. Timestamps are stored and sent between servers as UTC. This file only decides how a
 * moment is shown to people and how a time typed by a person is turned back into UTC. There are no fixed offsets:
 * the zone database inside Intl knows when EST (UTC-5) becomes EDT (UTC-4) and back.
 *
 * The client's zone is one setting (CLIENT_TIME_ZONE, default America/Toronto). To serve a client in another
 * country, change that setting. No application logic needs to change.
 */
export const DEFAULT_CLIENT_TIME_ZONE = "America/Toronto";

export type TimeInput = string | number | Date | null | undefined;

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

/** A valid zone name, or the fallback. */
export function resolveTimeZone(value: string | null | undefined, fallback: string = DEFAULT_CLIENT_TIME_ZONE): string {
  return isValidTimeZone(value) ? value.trim() : fallback;
}

/** The client's configured zone. Server side only reads the setting; browsers get the zone passed in as a prop. */
export function getClientTimeZone(): string {
  return resolveTimeZone(process.env.CLIENT_TIME_ZONE);
}

/**
 * The zone of the allowed sending window. CLIENT_TIME_ZONE wins. WHATSAPP_SEND_TIME_ZONE is the older setting and
 * is still honoured when CLIENT_TIME_ZONE is not set, so an existing deployment keeps working.
 */
export function getSendTimeZone(): string {
  const explicit = process.env.CLIENT_TIME_ZONE?.trim();
  if (isValidTimeZone(explicit)) return explicit;
  const legacy = process.env.WHATSAPP_SEND_TIME_ZONE?.trim();
  return isValidTimeZone(legacy) ? legacy : DEFAULT_CLIENT_TIME_ZONE;
}

export function toDate(value: TimeInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The calendar and clock reading in `timeZone` at this instant. */
function wallParts(date: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour") % 24, minute: read("minute"), second: read("second") };
}

/** Minutes the zone is ahead of UTC at this instant (EST is -300, EDT is -240). */
export function zoneOffsetMinutes(instantMs: number, timeZone: string): number {
  const wall = wallParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

/** The zone's short name at this instant: EST in winter, EDT in summer. */
export function zoneAbbreviation(value: TimeInput, timeZone: string = DEFAULT_CLIENT_TIME_ZONE): string {
  const date = toDate(value) ?? new Date();
  return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** 2026-11-04 (the date in the zone). */
export function formatDate(value: TimeInput, timeZone: string = getClientTimeZone()): string {
  const date = toDate(value);
  if (!date) return "—";
  const wall = wallParts(date, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** 2026-11-04 09:40 EST */
export function formatDateTime(value: TimeInput, timeZone: string = getClientTimeZone()): string {
  const date = toDate(value);
  if (!date) return "—";
  const wall = wallParts(date, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)} ${zoneAbbreviation(date, timeZone)}`;
}

/** 09:40 EST */
export function formatTimeOfDay(value: TimeInput, timeZone: string = getClientTimeZone()): string {
  const date = toDate(value);
  if (!date) return "—";
  const wall = wallParts(date, timeZone);
  return `${pad(wall.hour)}:${pad(wall.minute)} ${zoneAbbreviation(date, timeZone)}`;
}

/** Wed, Nov 4, 2026 */
export function formatLongDate(value: TimeInput, timeZone: string = getClientTimeZone()): string {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
}

/** 3:42:10 PM EST (for the clock) */
export function formatClockTime(value: TimeInput, timeZone: string = getClientTimeZone()): string {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" }).format(date);
}

/** Value for a `datetime-local` input (YYYY-MM-DDTHH:mm) showing this instant in the zone. */
export function utcToLocalInput(value: TimeInput, timeZone: string = getClientTimeZone()): string {
  const date = toDate(value);
  if (!date) return "";
  const wall = wallParts(date, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

export type LocalTimeResult =
  | { ok: true; iso: string; ambiguous: boolean }
  | { ok: false; reason: "invalid" | "gap" };

/**
 * Turns a wall-clock time typed in the zone (YYYY-MM-DDTHH:mm) into the exact UTC instant.
 * - A time that never happens (clocks jump forward, 02:30 on the spring change) is refused with reason "gap".
 * - A time that happens twice (clocks go back, 01:30 on the autumn change) uses the first one and sets `ambiguous`.
 */
export function zonedLocalToUtc(local: string, timeZone: string = getClientTimeZone()): LocalTimeResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return { ok: false, reason: "invalid" };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return { ok: false, reason: "invalid" };
  // The offset a day before and a day after bracket any clock change, so one of them (or both) fits.
  const offsets = new Set([zoneOffsetMinutes(guess - 86_400_000, timeZone), zoneOffsetMinutes(guess + 86_400_000, timeZone)]);
  const fits = [...offsets].map((offset) => guess - offset * 60_000).filter((instant) => zoneOffsetMinutes(instant, timeZone) === (guess - instant) / 60_000);
  if (fits.length === 0) return { ok: false, reason: "gap" };
  return { ok: true, iso: new Date(Math.min(...fits)).toISOString(), ambiguous: fits.length > 1 };
}

/** Today's date in the zone, as YYYY-MM-DD. */
export function todayInZone(timeZone: string = getClientTimeZone(), now: number = Date.now()): string {
  return formatDate(now, timeZone);
}

/** Adds calendar days to a YYYY-MM-DD date (no zone involved). */
export function addDaysToDate(day: string, days: number): string {
  const base = Date.parse(`${day}T00:00:00Z`) + days * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

/** The UTC instant a calendar day starts in the zone (local midnight). */
export function startOfDayUtc(day: string, timeZone: string = getClientTimeZone()): string {
  const result = zonedLocalToUtc(`${day}T00:00`, timeZone);
  // A zone whose clocks skip midnight starts that day at 01:00.
  return result.ok ? result.iso : (zonedLocalToUtc(`${day}T01:00`, timeZone) as { ok: true; iso: string }).iso;
}

/** The next time the clock in the zone reads `hour:00`, at least 5 minutes ahead (or tomorrow's when forced), as a datetime-local value. */
export function nextLocalHour(hour: number, timeZone: string = getClientTimeZone(), forceTomorrow = false, now: number = Date.now()): string {
  let day = todayInZone(timeZone, now);
  if (forceTomorrow) day = addDaysToDate(day, 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = `${day}T${pad(hour)}:00`;
    const result = zonedLocalToUtc(local, timeZone);
    if (result.ok && Date.parse(result.iso) >= now + 5 * 60_000) return local;
    day = addDaysToDate(day, 1);
  }
  return `${day}T${pad(hour)}:00`;
}
