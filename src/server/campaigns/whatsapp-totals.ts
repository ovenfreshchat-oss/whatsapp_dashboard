import { unstable_cache } from "next/cache";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { getConfiguredMetaIdentifiers, metaGraphGet } from "@/server/meta/client";
import { addDaysToDate, getClientTimeZone, startOfDayUtc, todayInZone } from "@/lib/timezone";

export type WhatsappTotals = {
  /** Per WhatsApp (message analytics for the whole number, every message type). Null when Meta could not be reached. */
  sent: number | null;
  delivered: number | null;
  /** Messages customers sent to you, from the inbox. */
  received: number | null;
  from: string;
  to: string;
};

const DAY = 86_400_000;
const calendarDay = (day: string) => Date.parse(`${day}T00:00:00Z`);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

/**
 * The period shown. Defaults to the last 28 days, like WhatsApp Manager. Dates are YYYY-MM-DD, inclusive, and are
 * calendar days in the client's time zone (a day runs from local midnight to local midnight).
 */
export function resolvePeriod(from: string | null, to: string | null, now: number = Date.now(), timeZone: string = getClientTimeZone()): { from: string; to: string } {
  const today = todayInZone(timeZone, now);
  const end = to && to <= today ? to : today;
  const start = from && from <= end ? from : addDaysToDate(end, -27);
  return { from: start, to: end };
}

async function fetchMetaSentDelivered(from: string, to: string, timeZone: string): Promise<{ sent: number; delivered: number } | null> {
  try {
    const { wabaId } = getConfiguredMetaIdentifiers();
    const start = Math.floor(Date.parse(startOfDayUtc(from, timeZone)) / 1000);
    const days = Math.round((calendarDay(to) - calendarDay(from)) / DAY) + 1;
    const granularity = days > 90 ? "MONTH" : "DAY";
    const attempts = [Math.floor(Date.parse(startOfDayUtc(addDaysToDate(to, 1), timeZone)) / 1000), Math.floor(Date.now() / 1000)];
    for (const end of attempts) {
      try {
        const payload = await metaGraphGet(wabaId, new URLSearchParams({
          fields: `analytics.start(${start}).end(${end}).granularity(${granularity})`,
        }));
        const analytics = payload.analytics as { data_points?: unknown } | undefined;
        if (!analytics || !Array.isArray(analytics.data_points)) continue;
        let sent = 0, delivered = 0;
        for (const point of analytics.data_points as Record<string, unknown>[]) {
          sent += num(point.sent);
          delivered += num(point.delivered);
        }
        return { sent, delivered };
      } catch {
        // try the next end timestamp
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchTotals(from: string, to: string, timeZone: string): Promise<WhatsappTotals> {
  const meta = await fetchMetaSentDelivered(from, to, timeZone);
  let received: number | null = null;
  const admin = createStaffAdminClient();
  if (admin) {
    const { count, error } = await admin.from("inbox_messages").select("id", { count: "exact", head: true })
      .eq("direction", "inbound")
      .gte("event_at", startOfDayUtc(from, timeZone)).lt("event_at", startOfDayUtc(addDaysToDate(to, 1), timeZone));
    if (!error) received = count ?? 0;
  }
  return { sent: meta?.sent ?? null, delivered: meta?.delivered ?? null, received, from, to };
}

/** Cached for five minutes so the dashboard does not call Meta on every load. */
const cachedTotals = unstable_cache(fetchTotals, ["whatsapp-message-totals"], { revalidate: 300 });

export function loadWhatsappTotals(from: string | null, to: string | null): Promise<WhatsappTotals> {
  const timeZone = getClientTimeZone();
  const period = resolvePeriod(from, to, Date.now(), timeZone);
  return cachedTotals(period.from, period.to, timeZone);
}
