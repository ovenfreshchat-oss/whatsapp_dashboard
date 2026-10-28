// Compares Meta's own analytics with what this database counted, then prints the SQL that
// makes the dashboard match. Run: npm run check:meta   (reads .env; prints totals only, never keys)
const env = process.env;
const required = ["META_GRAPH_API_VERSION", "META_WABA_ID", "META_SYSTEM_USER_ACCESS_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"];
const missing = required.filter((name) => !env[name]);
if (missing.length) { console.error(`Missing in .env: ${missing.join(", ")}`); process.exit(1); }

const graph = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;
const now = Math.floor(Date.now() / 1000);

async function meta(path, query = {}) {
  const url = new URL(`${graph}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.META_SYSTEM_USER_ACCESS_TOKEN}` } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}
const fail = (label, { status, body }) => `${label}: HTTP ${status} - ${body.error?.message ?? "no details"} (code ${body.error?.code ?? "?"})`;

// 1) Messaging analytics: total sent and delivered, widest window Meta allows.
let sent = null, delivered = null, window = null;
for (const days of [365, 180, 90, 30]) {
  const start = now - days * 86_400;
  const result = await meta(env.META_WABA_ID, { fields: `analytics.start(${start}).end(${now}).granularity(MONTH).phone_numbers([]).country_codes([])` });
  if (result.body.error) { console.log(fail(`Meta messaging analytics (${days} days)`, result)); continue; }
  const points = result.body.analytics?.data_points ?? [];
  sent = points.reduce((sum, p) => sum + (p.sent || 0), 0);
  delivered = points.reduce((sum, p) => sum + (p.delivered || 0), 0);
  window = days;
  console.log(`Meta messaging analytics, last ${days} days: sent ${sent}, delivered ${delivered}`);
  for (const p of points) console.log(`   ${new Date(p.start * 1000).toISOString().slice(0, 10)}  sent ${p.sent}  delivered ${p.delivered}`);
  break;
}

// 2) Pricing analytics: delivered volume per category (the dashboard's category cards).
const categories = { marketing: null, utility: null, authentication: null };
for (const days of [360, 90, 30]) {
  const result = await meta(`${env.META_WABA_ID}/pricing_analytics`, {
    start: now - days * 86_400, end: now, granularity: "MONTHLY",
    metric_types: JSON.stringify(["VOLUME"]), dimensions: JSON.stringify(["PRICING_CATEGORY"]),
  });
  if (result.body.error) { console.log(fail(`Meta pricing analytics (${days} days)`, result)); continue; }
  for (const key of Object.keys(categories)) categories[key] = 0;
  for (const node of result.body.data ?? []) {
    for (const point of node.data_points ?? [node]) {
      const category = String(point.pricing_category ?? "").toUpperCase();
      const volume = Number(point.volume) || 0;
      if (category.startsWith("MARKETING")) categories.marketing += volume;
      else if (category === "UTILITY") categories.utility += volume;
      else if (category.startsWith("AUTHENTICATION")) categories.authentication += volume;
    }
  }
  console.log(`Meta pricing analytics, last ${days} days:`, categories);
  break;
}

// 3) What the database counted (same rules as src/server/dashboard/metrics.ts).
async function count(table, filter) {
  const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${table}?select=id${filter}`, {
    method: "HEAD",
    headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, Prefer: "count=exact" },
  });
  const total = Number(response.headers.get("content-range")?.split("/")[1]);
  if (!Number.isFinite(total)) throw new Error(`Could not count ${table} (HTTP ${response.status})`);
  return total;
}
const campaignSent = await count("whatsapp_campaign_recipients", "&state=eq.accepted");
const campaignDelivered = await count("whatsapp_campaign_recipients", "&delivery_status=in.(delivered,read)");
const replySent = await count("inbox_messages", "&direction=eq.outbound&status=in.(sent,delivered,read)");
const replyDelivered = await count("inbox_messages", "&direction=eq.outbound&status=in.(delivered,read)");
const db = { sent: campaignSent + replySent, delivered: campaignDelivered + replyDelivered, marketing: campaignSent };
console.log(`\nDatabase counted: sent ${db.sent}, delivered ${db.delivered}, marketing ${db.marketing}`);

// 4) Ready-to-run SQL, filled with Meta's numbers where Meta returned them.
const rows = [
  ["messages_sent", sent], ["messages_delivered", delivered],
  ["marketing", categories.marketing], ["utility", categories.utility], ["authentication", categories.authentication],
].filter(([, total]) => total !== null);
if (!rows.length) { console.log("\nMeta returned no totals. Read them in WhatsApp Manager and use scripts/fix-dashboard-totals.sql."); process.exit(0); }
if (window && window < 365) console.log(`\nNote: Meta only returned the last ${window} days, so older messages are not in these totals.`);
const template = (await import("node:fs")).readFileSync(new URL("./fix-dashboard-totals.sql", import.meta.url), "utf8");
const values = rows.map(([metric, total]) => `  ('${metric}', ${total})`).join(",\n");
console.log("\n--- Run this in the Supabase SQL editor ---\n");
console.log(template.replace(/with meta\(metric, total\) as \(values[\s\S]*?\n\), db/, `with meta(metric, total) as (values\n${values}\n), db`));
