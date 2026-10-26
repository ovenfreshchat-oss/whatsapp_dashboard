/** Pure helpers for the WhatsApp inbox. No server-only imports, so they are unit-testable. */

export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ReplyWindow =
  | { open: true; closesAt: string; remainingLabel: string }
  | { open: false; closesAt: string | null; remainingLabel: null };

/** WhatsApp allows free-text replies only within 24 hours of the customer's last message. */
export function replyWindow(lastInboundAt: string | null, now: Date = new Date()): ReplyWindow {
  if (!lastInboundAt) return { open: false, closesAt: null, remainingLabel: null };
  const last = new Date(lastInboundAt);
  if (Number.isNaN(last.valueOf())) return { open: false, closesAt: null, remainingLabel: null };
  const closes = new Date(last.valueOf() + REPLY_WINDOW_MS);
  const remaining = closes.valueOf() - now.valueOf();
  if (remaining <= 0) return { open: false, closesAt: closes.toISOString(), remainingLabel: null };
  const minutes = Math.max(1, Math.floor(remaining / 60_000));
  const label = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return { open: true, closesAt: closes.toISOString(), remainingLabel: label };
}

export function formatPhone(waId: string): string {
  return /^\d{7,15}$/.test(waId) ? `+${waId}` : waId;
}

export function conversationTitle(profileName: string | null, waId: string): string {
  const name = profileName?.trim();
  return name ? name : formatPhone(waId);
}

export function safeTimeZone(value: string | undefined): string {
  if (!value) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
}

export function formatTime(iso: string | null, timeZone: string, opts: { withDate?: boolean } = {}): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    ...(opts.withDate === false ? {} : { day: "2-digit", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

export type OutboundStatus = "sending" | "sent" | "delivered" | "read" | "failed" | "uncertain";

export function statusLabel(status: string): string {
  switch (status) {
    case "sending": return "Sending…";
    case "sent": return "Sent";
    case "delivered": return "Delivered";
    case "read": return "Read";
    case "failed": return "Failed";
    case "uncertain": return "Outcome uncertain";
    default: return "";
  }
}

/** Maps the `begin_inbox_reply` exception codes to text safe to show staff. */
export function replyErrorMessage(code: string): string {
  switch (code) {
    case "window_closed":
      return "The 24-hour reply window has closed. WhatsApp only allows an approved template until the customer writes again.";
    case "opted_out":
      return "This customer has opted out. Do not message them.";
    case "sender_hold":
      return "Sending is on hold after an opt-out. Review it on the Sender holds page before replying.";
    case "invalid_reply":
      return "Enter a reply between 1 and 4096 characters.";
    case "invalid_recipient":
      return "This customer's WhatsApp ID is not a phone number, so a reply cannot be sent.";
    case "conversation_missing":
      return "This conversation no longer exists.";
    default:
      return "The reply could not be reserved. Nothing was sent.";
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** WhatsApp-style clock, e.g. "2:05 pm". */
export function formatClock(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("en-IN", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "Today", "Yesterday", a weekday for the last week, otherwise the date. */
export function formatDayLabel(iso: string, timeZone: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  const key = dayKey(date, timeZone);
  if (key === dayKey(now, timeZone)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) return "Yesterday";
  const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (ageDays < 6) return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(date);
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long", year: "numeric" }).format(date);
}

export function sameDay(a: string, b: string, timeZone: string): boolean {
  return dayKey(new Date(a), timeZone) === dayKey(new Date(b), timeZone);
}

/** Chat-list timestamp: clock today, "Yesterday", otherwise dd/mm/yyyy. */
export function formatListTime(iso: string | null, timeZone: string, now: Date = new Date()): string {
  if (!iso) return "";
  const label = formatDayLabel(iso, timeZone, now);
  if (label === "Today") return formatClock(iso, timeZone);
  if (label === "Yesterday") return label;
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
}
