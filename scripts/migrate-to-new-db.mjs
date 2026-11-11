#!/usr/bin/env node
/**
 * Moves the whole app from one Supabase project to another: schema check, all public tables, staff logins
 * (auth.users + auth.identities) and, optionally, recent campaign media files.
 *
 * Needs (in .env):
 *   SOURCE_DB_URL / TARGET_DB_URL                   postgresql:// connection strings (Session pooler)
 *   SOURCE_URL, SOURCE_SERVICE_KEY, TARGET_URL, TARGET_SERVICE_KEY    only for --storage
 *
 *   Step 1  npm run db:migrate -- --target-env TARGET_DB_URL   (creates the empty schema in the new project)
 *   Step 2  npm run db:move -- --dry-run                       (row counts, nothing written)
 *   Step 3  pause sending (WHATSAPP_SENDS_ENABLED=false, no running campaigns), then:
 *           npm run db:move -- --wipe --yes [--storage] [--storage-days 30] [--no-auth]
 *
 * The source database is only READ. The target is truncated first (--wipe) so the copy is exact.
 * Triggers and foreign keys are switched off on the target while copying, so webhook/inbox triggers do not
 * run twice and table order does not matter. Row counts are compared at the end.
 */
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const dryRun = flag("dry-run");
const sourceUrl = process.env.SOURCE_DB_URL;
const targetUrl = process.env.TARGET_DB_URL;
if (!sourceUrl || !targetUrl) { console.error("Set SOURCE_DB_URL and TARGET_DB_URL in .env."); process.exit(1); }
if (sourceUrl === targetUrl) { console.error("SOURCE_DB_URL and TARGET_DB_URL are the same database. Stopping."); process.exit(1); }
if (!dryRun && !flag("yes")) { console.error("This overwrites the target database. Re-run with --yes (and --wipe), or use --dry-run first."); process.exit(1); }

let pg;
try { pg = (await import("pg")).default; } catch { console.error("Run: npm install --save-dev pg"); process.exit(1); }
const hostOf = (url) => { try { return new URL(url).username.split(".")[1] ?? new URL(url).host; } catch { return "database"; } };
const connect = async (url, label) => {
  const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  try { await client.connect(); } catch (error) { console.error(`Could not connect to the ${label} database (${hostOf(url)}): ${error.message}`); process.exit(1); }
  return client;
};
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const full = (schema, table) => `${q(schema)}.${q(table)}`;

const source = await connect(sourceUrl, "source");
const target = await connect(targetUrl, "target");
console.log(`Source project ${hostOf(sourceUrl)}  ->  target project ${hostOf(targetUrl)}${dryRun ? "  (dry run)" : ""}\n`);

async function copyStorage() {
  const need = ["SOURCE_URL", "SOURCE_SERVICE_KEY", "TARGET_URL", "TARGET_SERVICE_KEY"].filter((name) => !process.env[name]);
  if (need.length) { console.error(`\nStorage not copied: set ${need.join(", ")} in .env.`); process.exitCode = 1; return; }
  const { createClient } = await import("@supabase/supabase-js");
  const days = flag("storage-all") ? 36500 : Number(value("storage-days") ?? 30);
  const cutoff = Date.now() - days * 86_400_000;
  const BUCKET = "campaign-media";
  const old = createClient(process.env.SOURCE_URL, process.env.SOURCE_SERVICE_KEY, { auth: { persistSession: false } }).storage.from(BUCKET);
  const next = createClient(process.env.TARGET_URL, process.env.TARGET_SERVICE_KEY, { auth: { persistSession: false } }).storage.from(BUCKET);
  const walk = async (prefix) => {
    const files = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await old.list(prefix, { limit: 1000, offset });
      if (error) throw new Error(`Listing ${prefix || "/"} failed: ${error.message}`);
      for (const entry of data ?? []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) files.push(...await walk(path));
        else files.push({ path, at: Date.parse(entry.created_at ?? entry.updated_at ?? "") || 0 });
      }
      if ((data ?? []).length < 1000) break;
    }
    return files;
  };
  const wanted = (await walk("")).filter((file) => file.at >= cutoff);
  console.log(`\nCopying ${wanted.length} media file(s)${flag("storage-all") ? "" : ` from the last ${days} days`} (downloads from the source project)...`);
  let moved = 0, failed = 0;
  for (const file of wanted) {
    const { data, error } = await old.download(file.path);
    if (error || !data) { failed += 1; console.log(`  FAILED download ${file.path}: ${error?.message ?? "no data"}`); continue; }
    const { error: uploadError } = await next.upload(file.path, data, { contentType: data.type || undefined, upsert: true, cacheControl: "31536000" });
    if (uploadError) { failed += 1; console.log(`  FAILED upload ${file.path}: ${uploadError.message}`); } else moved += 1;
    if (moved % 25 === 0 && moved) console.log(`  ${moved}/${wanted.length}`);
  }
  const oldPrefix = `${process.env.SOURCE_URL.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/`;
  const newPrefix = `${process.env.TARGET_URL.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/`;
  await target.query(`update public.whatsapp_campaigns set header_media_url = replace(header_media_url, $1, $2) where header_media_url like $1 || '%'`, [oldPrefix, newPrefix]);
  await target.query(`update public.whatsapp_media_cache set source_url = replace(source_url, $1, $2) where source_url like $1 || '%'`, [oldPrefix, newPrefix]);
  console.log(`Copied ${moved} file(s), ${failed} failed. Campaign media links now point at the new project.`);
  if (failed) process.exitCode = 1;
}

try {
  if (flag("storage-only")) { await copyStorage(); process.exit(process.exitCode ?? 0); }
  const tables = (await source.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
       and table_name <> 'app_migrations' order by table_name`)).rows.map((row) => ({ schema: "public", table: row.table_name }));
  if (!flag("no-auth")) tables.unshift({ schema: "auth", table: "users" }, { schema: "auth", table: "identities" });

  const targetHas = new Set((await target.query(
    `select table_schema || '.' || table_name as t from information_schema.tables where table_schema in ('public','auth')`)).rows.map((row) => row.t));
  const missing = tables.filter((item) => !targetHas.has(`${item.schema}.${item.table}`));
  if (missing.length) {
    console.error("The target is missing tables:\n  " + missing.map((item) => `${item.schema}.${item.table}`).join("\n  "));
    console.error("\nRun the migrations on the target first: npm run db:migrate -- --target-env TARGET_DB_URL");
    process.exit(1);
  }

  const columnsOf = async (client, item) => (await client.query(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2
       and is_generated = 'NEVER' order by ordinal_position`, [item.schema, item.table])).rows.map((row) => row.column_name);
  const count = async (client, item) => Number((await client.query(`select count(*)::bigint as n from ${full(item.schema, item.table)}`)).rows[0].n);

  console.log("table".padEnd(44) + "source".padStart(10) + "target".padStart(10));
  for (const item of tables) {
    console.log(`${item.schema}.${item.table}`.padEnd(44) + String(await count(source, item)).padStart(10) + String(await count(target, item)).padStart(10));
  }
  if (dryRun) { console.log("\nDry run: nothing was written."); process.exit(0); }

  let existing = 0;
  for (const item of tables) existing += await count(target, item);
  if (existing > 0 && !flag("wipe")) {
    console.error("\nThe target already has rows. Add --wipe to empty its tables first (this deletes them).");
    process.exit(1);
  }

  await target.query("set session_replication_role = replica"); // no triggers, no foreign-key checks
  if (flag("wipe")) {
    // Public tables are truncated. Supabase's own auth tables are never truncated (that cascades into tables and
    // counters your database user does not own), so their rows are deleted instead.
    const publicTables = tables.filter((item) => item.schema === "public");
    await target.query(`truncate table ${publicTables.map((item) => full(item.schema, item.table)).join(", ")} cascade`);
    if (tables.some((item) => item.schema === "auth")) {
      await target.query("delete from auth.identities");
      await target.query("delete from auth.users");
    }
    console.log("\nTarget tables emptied.");
  }

  const BATCH = 500;
  console.log("\nCopying...");
  for (const item of tables) {
    const [from, to] = await Promise.all([columnsOf(source, item), columnsOf(target, item)]);
    const cols = to.filter((name) => from.includes(name));
    if (!cols.length) continue;
    const key = (await source.query(
      `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)`, [full(item.schema, item.table)])).rows.map((row) => q(row.attname));
    const order = key.length ? key.join(", ") : "ctid";
    const list = cols.map(q).join(", ");
    let copied = 0;
    for (let offset = 0; ; offset += BATCH) {
      const page = await source.query(
        `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as rows from
           (select ${list} from ${full(item.schema, item.table)} order by ${order} limit ${BATCH} offset ${offset}) x`);
      const rows = page.rows[0].rows;
      if (!rows.length) break;
      await target.query(
        `insert into ${full(item.schema, item.table)} (${list}) overriding system value
           select ${list} from jsonb_populate_recordset(null::${full(item.schema, item.table)}, $1::jsonb) on conflict do nothing`, [JSON.stringify(rows)]);
      copied += rows.length;
      if (rows.length < BATCH) break;
    }
    console.log(`  ${`${item.schema}.${item.table}`.padEnd(42)} ${copied}`);
  }

  // Auto-numbered columns continue after the highest copied value.
  const serials = (await target.query(
    `select table_schema, table_name, column_name from information_schema.columns
      where table_schema in ('public','auth') and column_default like 'nextval(%'`)).rows;
  for (const s of serials) {
    if (!tables.some((item) => item.schema === s.table_schema && item.table === s.table_name)) continue;
    await target.query(
      `select setval(pg_get_serial_sequence($1, $2), coalesce(max(${q(s.column_name)}), 1), max(${q(s.column_name)}) is not null) from ${full(s.table_schema, s.table_name)}`,
      [`${q(s.table_schema)}.${q(s.table_name)}`, s.column_name]);
  }
  await target.query("set session_replication_role = default");

  console.log("\nVerifying row counts...");
  let bad = 0;
  for (const item of tables) {
    const [a, b] = [await count(source, item), await count(target, item)];
    if (a !== b) { bad += 1; console.log(`  MISMATCH ${item.schema}.${item.table}: source ${a}, target ${b}`); }
  }
  console.log(bad ? `\n${bad} table(s) differ. Check them before switching the app.` : "All row counts match.");

  if (flag("storage") || flag("storage-all")) await copyStorage();

  console.log(`
Next steps:
  1. In Vercel set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY to the NEW project, then redeploy.
  2. In Supabase (new project) > Authentication > URL configuration, set the site URL to your app address.
  3. Staff keep their email and password but must sign in again (the new project has its own session keys).
  4. Turn sending back on (WHATSAPP_SENDS_ENABLED=true) only after the dashboard looks right.`);
} finally {
  await source.end();
  await target.end();
}
