import { unstable_cache } from "next/cache";
import { createStaffAdminClient } from "@/server/auth/staff-users/admin";
import { getConfiguredMetaIdentifiers, metaGraphGet } from "@/server/meta/client";

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
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

/** The period shown. Defaults to the last 28 days, like WhatsApp Manager. Dates are YYYY-MM-DD, inclusive. */
export function resolvePeriod(from: string | null, to: string | null, now: number = Date.now()): { from: string; to: string } {
  const today = isoDay(now);
  const end = to && to <= today ? to : today;
  const start = from && from <= end ? from : isoDay(midnight(end) - 27 * DAY);
  return { from: start, to: end };
}

async function fetchMetaSentDelivered(from: string, to: string): Promise<{ sent: number; delivered: number } | null> {
  try {
    const { wabaId } = getConfiguredMetaIdentifiers();
    const start = Math.floor(midnight(from) / 1000);
    const days = Math.round((midnight(to) - midnight(from)) / DAY) + 1;
    const granularity = days > 90 ? "MONTH" : "DAY";
    const attempts = [Math.floor((midnight(to) + DAY) / 1000), Math.floor(Date.now() / 1000)];
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

async function fetchTotals(from: string, to: string): Promise<WhatsappTotals> {
  const meta = await fetchMetaSentDelivered(from, to);
  let received: number | null = null;
  const admin = createStaffAdminClient();
  if (admin) {
    const { count, error } = await admin.from("inbox_messages").select("id", { count: "exact", head: true })
      .eq("direction", "inbound")
      .gte("event_at", `${from}T00:00:00Z`).lt("event_at", new Date(midnight(to) + DAY).toISOString());
    if (!error) received = count ?? 0;
  }
  return { sent: meta?.sent ?? null, delivered: meta?.delivered ?? null, received, from, to };
}

/** Cached for five minutes so the dashboard does not call Meta on every load. */
const cachedTotals = unstable_cache(fetchTotals, ["whatsapp-message-totals"], { revalidate: 300 });

export function loadWhatsappTotals(from: string | null, to: string | null): Promise<WhatsappTotals> {
  const period = resolvePeriod(from, to);
  return cachedTotals(period.from, period.to);
}
