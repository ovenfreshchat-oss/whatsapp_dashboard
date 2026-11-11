// Compares Meta's own analytics with what this database counted. Run: npm run check:meta  (add -- --sql for the optional fallback-baseline SQL)
// Reads .env; prints totals only, never keys.
const env = process.env;
// Exit after a short pause: quitting while the network connection is still closing prints a harmless but ugly error on Windows.
const finish = async (code) => { await new Promise((resolve) => setTimeout(resolve, 250)); process.exit(code); };
const flag = (name) => process.argv.includes(`--${name}`);
const argValue = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const rangeMode = Boolean(argValue("from")) || flag("categories");
const required = ["META_GRAPH_API_VERSION", "META_WABA_ID", "META_SYSTEM_USER_ACCESS_TOKEN", ...(rangeMode ? [] : ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"])];
const missing = required.filter((name) => !env[name]);
if (missing.length) { console.error(`Missing in .env: ${missing.join(", ")}`); await finish(1); }

const graph = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}`;
const now = Math.floor(Date.now() / 1000);
const DAY_SECONDS = 86_400;

async function meta(path, query = {}) {
  const url = new URL(`${graph}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.META_SYSTEM_USER_ACCESS_TOKEN}` } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}
const fail = (label, { status, body }) => `${label}: HTTP ${status} - ${body.error?.message ?? "no details"} (code ${body.error?.code ?? "?"})`;

// Direct-from-Meta modes (no database, no dashboard):
//   npm run check:meta -- --categories                      the dashboard's "Messages by category" card: delivered, per Meta, 12 months
//   npm run check:meta -- --from 2026-11-06 --to 2026-11-06  sent/delivered per day plus billed messages per category (UTC days)
const categoryRows = async (start, end, granularity, metricTypes) => {
  const pricing = await meta(`${env.META_WABA_ID}/pricing_analytics`, {
    start, end, granularity, metric_types: JSON.stringify(metricTypes), dimensions: JSON.stringify(["PRICING_CATEGORY"]),
  });
  if (pricing.body.error) return { error: fail("Pricing analytics", pricing), rows: [] };
  const rows = [];
  for (const node of pricing.body.data ?? []) for (const point of node.data_points ?? [node]) {
    rows.push({ category: String(point.pricing_category ?? "UNKNOWN"), at: point.start ? new Date(point.start * 1000).toISOString().slice(0, 10) : "", volume: Number(point.volume) || 0, cost: Number(point.cost) || 0 });
  }
  return { error: null, rows };
};
const printCategories = (rows, withCost) => {
  const byCategory = new Map(), byMonth = new Map();
  for (const row of rows) {
    const total = byCategory.get(row.category) ?? { volume: 0, cost: 0 };
    total.volume += row.volume; total.cost += row.cost; byCategory.set(row.category, total);
    const key = `${row.at.slice(0, 7)} ${row.category}`;
    byMonth.set(key, (byMonth.get(key) ?? 0) + row.volume);
  }
  if (!byCategory.size) { console.log("  nothing returned for this range"); return byCategory; }
  if (byMonth.size > byCategory.size) for (const [key, volume] of [...byMonth].sort()) console.log(`  ${key.padEnd(30)} ${String(volume).padStart(6)}`);
  console.log("  ----");
  for (const [category, total] of byCategory) console.log(`  ${category.padEnd(30)} ${String(total.volume).padStart(6)}${withCost ? `   cost ${total.cost.toFixed(4)}` : ""}`);
  return byCategory;
};

if (flag("categories")) {
  const start = now - 360 * DAY_SECONDS;
  console.log("Delivered messages by category, per Meta, last 360 days (the same request the dashboard card makes):\n");
  const { error, rows } = await categoryRows(start, now, "MONTHLY", ["VOLUME"]);
  if (error) { console.log(error); await finish(1); }
  const totals = printCategories(rows, false);
  let marketing = 0, utility = 0, authentication = 0;
  for (const [category, total] of totals) {
    const name = category.toUpperCase();
    if (name.startsWith("MARKETING")) marketing += total.volume; else if (name === "UTILITY") utility += total.volume; else if (name.startsWith("AUTHENTICATION")) authentication += total.volume;
  }
  console.log(`\nDashboard card shows: Marketing ${marketing}, Utility ${utility}, Authentication ${authentication}`);
  await finish(0);
}

if (rangeMode) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = argValue("from"), to = argValue("to") ?? new Date().toISOString().slice(0, 10);
  if (!day.test(from) || !day.test(to) || from > to) { console.error("Use --from YYYY-MM-DD and --to YYYY-MM-DD (from must not be after to)."); await finish(1); }
  const start = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const end = Math.min(now, Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000) + DAY_SECONDS);
  const days = Math.ceil((end - start) / DAY_SECONDS);
  console.log(`Meta, straight from the Graph API: ${from} to ${to} (UTC days, ${days} days)\n`);
  let totalSent = 0, totalDelivered = 0, failedChunk = false;
  const perDay = [];
  for (let chunkStart = start; chunkStart < end; chunkStart += 85 * DAY_SECONDS) {
    const chunkEnd = Math.min(end, chunkStart + 85 * DAY_SECONDS);
    const result = await meta(env.META_WABA_ID, { fields: `analytics.start(${chunkStart}).end(${chunkEnd}).granularity(DAY).phone_numbers([]).country_codes([])` });
    if (result.body.error) { console.log(fail(`Messaging analytics ${new Date(chunkStart * 1000).toISOString().slice(0, 10)}`, result)); failedChunk = true; continue; }
    for (const p of result.body.analytics?.data_points ?? []) {
      totalSent += p.sent || 0; totalDelivered += p.delivered || 0;
      perDay.push(`  ${new Date(p.start * 1000).toISOString().slice(0, 10)}  sent ${String(p.sent ?? 0).padStart(5)}  delivered ${String(p.delivered ?? 0).padStart(5)}`);
    }
  }
  if (days <= 31) for (const line of perDay) console.log(line);
  else console.log(`  (${perDay.length} days with data; per-day lines hidden for long ranges)`);
  console.log(`  TOTAL          sent ${String(totalSent).padStart(5)}  delivered ${String(totalDelivered).padStart(5)}  (${totalSent ? ((totalDelivered / totalSent) * 100).toFixed(1) : "0"}% delivered)${failedChunk ? "   [some periods failed: totals incomplete]" : ""}`);
  console.log(`\nBilled / delivered by category, per Meta (${days <= 90 ? "daily" : "monthly"} buckets):`);
  const { error, rows } = await categoryRows(start, end, days <= 90 ? "DAILY" : "MONTHLY", ["COST", "VOLUME"]);
  if (error) { console.log(error); await finish(1); }
  printCategories(rows, true);
  if (days > 90) console.log("\nNote: for ranges over 90 days Meta returns whole calendar months, so the first and last month can include days outside your dates.");
  await finish(0);
}

// 1) Messaging analytics: total sent and delivered. Daily buckets in chunks of at most 90 days, exactly like the
//    dashboard does, so the current month is included (monthly buckets leave out the month in progress).
let sent = null, delivered = null, window = null;
const CHUNK_DAYS = 85;
{
  const byMonth = new Map();
  let totalSent = 0, totalDelivered = 0, coveredFrom = null, lastError = null;
  for (let offset = 365; offset > 0; offset -= CHUNK_DAYS) {
    const start = now - offset * DAY_SECONDS;
    const end = Math.min(now, start + CHUNK_DAYS * DAY_SECONDS);
    const result = await meta(env.META_WABA_ID, { fields: `analytics.start(${start}).end(${end}).granularity(DAY).phone_numbers([]).country_codes([])` });
    if (result.body.error) { lastError = fail(`Meta messaging analytics (${new Date(start * 1000).toISOString().slice(0, 10)} to ${new Date(end * 1000).toISOString().slice(0, 10)})`, result); continue; }
    const points = result.body.analytics?.data_points ?? [];
    if (points.length && coveredFrom === null) coveredFrom = offset;
    for (const p of points) {
      totalSent += p.sent || 0; totalDelivered += p.delivered || 0;
      const month = new Date(p.start * 1000).toISOString().slice(0, 7);
      const row = byMonth.get(month) ?? { sent: 0, delivered: 0 };
      row.sent += p.sent || 0; row.delivered += p.delivered || 0; byMonth.set(month, row);
    }
  }
  if (byMonth.size) {
    sent = totalSent; delivered = totalDelivered; window = coveredFrom;
    console.log(`Meta messaging analytics, last 365 days (daily data, includes this month): sent ${sent}, delivered ${delivered}`);
    for (const [month, row] of [...byMonth].sort()) console.log(`   ${month}  sent ${row.sent}  delivered ${row.delivered}`);
  } else if (lastError) {
    console.log(lastError);
  } else {
    console.log("Meta messaging analytics returned no data.");
  }
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

// 4) Comparison. The dashboard reads Meta live, so nothing needs to be "fixed" in the database.
console.log("\nHow to read this:");
console.log("  - Meta sent/delivered are account-wide analytics (what the dashboard cards 'per WhatsApp' show).");
console.log("  - Marketing from Meta counts DELIVERED, billed marketing messages; the database counts every message Meta ACCEPTED,");
console.log("    so the database number is higher by the messages that failed (for example Meta 131049 holds).");
console.log("  - Database 'delivered' only counts delivery receipts that reached the webhook.");
if (!flag("sql")) {
  console.log("\nThe dashboard now shows Meta's numbers, so no SQL is needed. Add --sql only if you want the optional fallback");
  console.log("baseline script (used only when Meta cannot be reached): npm run check:meta -- --sql");
  await finish(0);
}

// 5) Optional (--sql): ready-to-run baseline SQL, filled with Meta's numbers where Meta returned them.
const rows = [
  ["messages_sent", sent], ["messages_delivered", delivered],
  ["marketing", categories.marketing], ["utility", categories.utility], ["authentication", categories.authentication],
].filter(([, total]) => total !== null);
if (!rows.length) { console.log("\nMeta returned no totals. Read them in WhatsApp Manager and use scripts/fix-dashboard-totals.sql."); await finish(0); }
if (window && window < 365) console.log(`\nNote: Meta data starts about ${window} days ago, so older messages are not in these totals.`);
const template = (await import("node:fs")).readFileSync(new URL("./fix-dashboard-totals.sql", import.meta.url), "utf8");
const values = rows.map(([metric, total]) => `  ('${metric}', ${total})`).join(",\n");
console.log("\n--- Optional: run this in the Supabase SQL editor (only affects the cards when Meta is unreachable) ---\n");
console.log(template.replace(/with meta\(metric, total\) as \(values[\s\S]*?\n\), db/, `with meta(metric, total) as (values\n${values}\n), db`));
