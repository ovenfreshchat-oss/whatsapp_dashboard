import { getConfiguredMetaIdentifiers, metaGraphGet } from "@/server/meta/client";
import { getCampaignStore } from "./store";

export type RateCard = { currency: string; rates: Record<string, number> };

/**
 * Per-message marketing rates by calling code, copied from Meta's published rate card for your
 * billing currency. Example: WHATSAPP_RATE_CARD={"currency":"USD","rates":{"91":0.0000,"1":0.0000}}
 * (fill in the real numbers). Rates change, so they are configuration, not code.
 */
export function getRateCard(): RateCard | null {
  const raw = process.env.WHATSAPP_RATE_CARD?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { currency?: unknown; rates?: unknown };
    if (typeof parsed.currency !== "string" || !/^[A-Za-z]{3}$/.test(parsed.currency) ||
        !parsed.rates || typeof parsed.rates !== "object") return null;
    const rates: Record<string, number> = {};
    for (const [prefix, value] of Object.entries(parsed.rates as Record<string, unknown>)) {
      if (/^[1-9][0-9]{0,3}$/.test(prefix) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
        rates[prefix] = value;
      }
    }
    return Object.keys(rates).length ? { currency: parsed.currency.toUpperCase(), rates } : null;
  } catch {
    return null;
  }
}

export type CostEstimate = {
  currency: string;
  total: number;
  messages: number;
  unpriced: number;
  markets: { prefix: string; count: number; rate: number; subtotal: number }[];
};

/** Longest matching calling-code prefix wins (e.g. "1242" before "1"). */
export function estimateCost(phones: string[], card: RateCard): CostEstimate {
  const prefixes = Object.keys(card.rates).sort((a, b) => b.length - a.length);
  const counts = new Map<string, number>();
  let unpriced = 0;
  for (const phone of phones) {
    const digits = phone.replace(/^\+/, "");
    const prefix = prefixes.find((candidate) => digits.startsWith(candidate));
    if (!prefix) { unpriced += 1; continue; }
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const markets = [...counts.entries()].map(([prefix, count]) => ({
    prefix, count, rate: card.rates[prefix], subtotal: count * card.rates[prefix],
  })).sort((a, b) => b.count - a.count);
  return {
    currency: card.currency,
    total: markets.reduce((sum, market) => sum + market.subtotal, 0),
    messages: phones.length - unpriced,
    unpriced,
    markets,
  };
}

/** Phone numbers of a campaign's recipients in the given send states / delivery statuses. */
export async function listCampaignPhones(
  campaignId: string,
  filter: { states?: string[]; deliveryStatuses?: string[] },
): Promise<string[]> {
  const store = getCampaignStore();
  const phones: string[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    let query = store.from("whatsapp_campaign_recipients").select("recipient_e164").eq("campaign_id", campaignId);
    if (filter.states) query = query.in("state", filter.states);
    if (filter.deliveryStatuses) query = query.in("delivery_status", filter.deliveryStatuses);
    const { data, error } = await query.order("id").range(from, from + 999);
    if (error) throw new Error("Recipients could not be loaded.");
    for (const row of data ?? []) phones.push(row.recipient_e164 as string);
    if ((data?.length ?? 0) < 1000) break;
  }
  return phones;
}

export type BilledCost = { cost: number; volume: number; from: string; to: string };

/**
 * What Meta billed for marketing messages in the campaign's time window (WABA-wide, so other
 * marketing sends in the same window are included). Returns null when Meta cannot provide it.
 */
export async function getMetaBilledCost(fromIso: string, toIso: string): Promise<BilledCost | null> {
  try {
    const from = Math.floor(Date.parse(fromIso) / 1000);
    const to = Math.ceil(Date.parse(toIso) / 1000);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 7 * 86_400) return null;
    const { wabaId } = getConfiguredMetaIdentifiers();
    const payload = await metaGraphGet(`${wabaId}/pricing_analytics`, new URLSearchParams({
      start: String(from), end: String(to), granularity: "HALF_HOUR",
      metric_types: JSON.stringify(["COST", "VOLUME"]),
      pricing_categories: JSON.stringify(["MARKETING", "MARKETING_LITE"]),
      dimensions: JSON.stringify(["PRICING_CATEGORY"]),
    }));
    let cost = 0, volume = 0, found = false;
    const rows = (value: unknown): Record<string, unknown>[] =>
      Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
    for (const node of rows(payload.data)) {
      const points = Array.isArray(node.data_points) ? rows(node.data_points) : [node];
      for (const point of points) {
        const c = Number(point.cost), v = Number(point.volume);
        if (Number.isFinite(c)) { cost += c; found = true; }
        if (Number.isFinite(v)) { volume += v; found = true; }
      }
    }
    return found ? { cost, volume, from: fromIso, to: toIso } : null;
  } catch {
    return null;
  }
}
