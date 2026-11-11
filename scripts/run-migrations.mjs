#!/usr/bin/env node
/**
 * Applies every drizzle/NNNN_*.sql file, in numeric order, to a Supabase/PostgreSQL database.
 *
 *   npm run db:migrate                       # database from DATABASE_URL (or --target)
 *   npm run db:migrate -- --target new       # NEW_DB_URL      (--target old = OLD_DB_URL)
 *   npm run db:migrate -- --target-env TARGET_DB_URL   # any env variable name
 *   npm run db:migrate -- --dry-run          # list what would run, touch nothing
 *   npm run db:migrate -- --from 0030        # run 0030 and later only
 *   npm run db:migrate -- --only 0031,0032   # run just these
 *   npm run db:migrate -- --baseline 0030    # mark 0001..0030 as already applied, run nothing
 *   npm run db:migrate -- --all              # re-run everything, even files already recorded
 *
 * Every migration in this repo is written to be safe to re-run. Applied files are recorded in
 * public.app_migrations (name + sha256), so a normal run only applies new or edited files.
 * Each file runs as one transaction: if a statement fails, that file is rolled back and the run stops.
 *
 * Use the Supabase connection string (Project settings > Database). If the direct host fails with an
 * IPv6/ENOTFOUND error, use the "Session pooler" string instead.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const target = value("target");
const envName = value("target-env") ?? (target === "new" ? "NEW_DB_URL" : target === "old" ? "OLD_DB_URL" : "DATABASE_URL");
const url = process.env[envName];
const dryRun = flag("dry-run");
const prefix = (name) => name.slice(0, 4);
const pad = (text) => String(text).padStart(4, "0");

const files = (await readdir(dir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
let selected = files;
if (value("from")) selected = selected.filter((name) => prefix(name) >= pad(value("from")));
if (value("only")) {
  const wanted = new Set(value("only").split(",").map((item) => pad(item.trim())));
  selected = selected.filter((name) => wanted.has(prefix(name)));
}

if (dryRun && !url) {
  console.log(`Dry run (no ${envName} set). ${selected.length} file(s) in order:`);
  for (const name of selected) console.log(`  ${name}`);
  process.exit(0);
}
if (!url) {
  console.error(`Set ${envName} to your database connection string (or pass --target new|old).`);
  process.exit(1);
}

let pg;
try {
  pg = (await import("pg")).default;
} catch {
  console.error("The 'pg' package is missing. Run: npm install --save-dev pg");
  process.exit(1);
}

const host = (() => { try { return new URL(url).host; } catch { return "database"; } })();
const client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
const sha = (text) => createHash("sha256").update(text).digest("hex");

try {
  await client.connect();
} catch (error) {
  console.error(`Could not connect to ${host}: ${error.message}`);
  console.error("If this is an IPv6 / ENOTFOUND error, use the Session pooler connection string from Supabase.");
  process.exit(1);
}

let applied = 0, skipped = 0;
try {
  await client.query(`create table if not exists public.app_migrations (
    name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
  await client.query("alter table public.app_migrations enable row level security");
  const recorded = new Map((await client.query("select name, sha256 from public.app_migrations")).rows.map((row) => [row.name, row.sha256]));

  if (value("baseline")) {
    const limit = pad(value("baseline"));
    for (const name of files.filter((item) => prefix(item) <= limit)) {
      const hash = sha(await readFile(join(dir, name), "utf8"));
      await client.query(`insert into public.app_migrations (name, sha256) values ($1, $2)
        on conflict (name) do update set sha256 = excluded.sha256`, [name, hash]);
      console.log(`baseline  ${name}`);
    }
    console.log(`Marked everything up to ${limit} as applied on ${host}. Nothing was run.`);
  } else {
    console.log(`${dryRun ? "Dry run on" : "Migrating"} ${host}`);
    for (const name of selected) {
      const sql = await readFile(join(dir, name), "utf8");
      const hash = sha(sql);
      if (!flag("all") && recorded.get(name) === hash) { console.log(`skip      ${name}`); skipped += 1; continue; }
      if (dryRun) { console.log(`would run ${name}`); continue; }
      process.stdout.write(`apply     ${name} ... `);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(`insert into public.app_migrations (name, sha256) values ($1, $2)
          on conflict (name) do update set sha256 = excluded.sha256, applied_at = now()`, [name, hash]);
        await client.query("commit");
        console.log("ok");
        applied += 1;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        console.log("FAILED");
        console.error(`\n${name} was rolled back and the run stopped.`);
        console.error(`${error.message}${error.position ? ` (at character ${error.position})` : ""}`);
        process.exitCode = 1;
        break;
      }
    }
    if (!process.exitCode) console.log(`\nDone. ${applied} applied, ${skipped} already up to date.`);
  }
} finally {
  await client.end();
}
