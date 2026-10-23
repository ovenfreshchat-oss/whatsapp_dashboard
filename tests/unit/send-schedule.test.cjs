const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const file = path.resolve(__dirname, "../../src/server/campaigns/send-schedule.ts");
const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(file, module);
loaded.filename = file;
loaded._compile(output, file);
const { nextWaitMs, hasPendingWork, MIN_WAIT_MS, MAX_WAIT_MS } = loaded.exports;

const idle = { running_pending: false, in_flight: false, next_scheduled_at: null };
const now = new Date("2026-10-23T12:00:00Z");
const alwaysOpen = () => true;
const neverOpen = () => false;
// Window open 03:00-18:00 UTC each day.
const dayWindow = (d) => d.getUTCHours() >= 3 && d.getUTCHours() < 18;

test("nothing to do ends the run", () => {
  assert.equal(hasPendingWork(idle), false);
  assert.equal(nextWaitMs(idle, alwaysOpen, now), null);
});

test("pending recipients inside the window tick again after the minimum wait", () => {
  assert.equal(nextWaitMs({ ...idle, running_pending: true }, alwaysOpen, now), MIN_WAIT_MS);
});

test("pending recipients outside the window sleep until it opens", () => {
  const night = new Date("2026-10-23T20:00:00Z");
  const wait = nextWaitMs({ ...idle, running_pending: true }, dayWindow, night);
  const wake = new Date(night.getTime() + wait);
  assert.ok(wake.getUTCHours() === 3 || (wake.getUTCHours() === 2 && wake.getUTCMinutes() >= 55));
  assert.ok(wait <= MAX_WAIT_MS);
});

test("a future scheduled campaign sleeps until its time (capped at 12h)", () => {
  const soon = new Date(now.getTime() + 10 * 60_000).toISOString();
  const wait = nextWaitMs({ ...idle, next_scheduled_at: soon }, alwaysOpen, now);
  assert.ok(wait >= 9.9 * 60_000 && wait <= 10.1 * 60_000);
  const far = new Date(now.getTime() + 3 * 24 * 3600_000).toISOString();
  assert.equal(nextWaitMs({ ...idle, next_scheduled_at: far }, alwaysOpen, now), MAX_WAIT_MS);
});

test("a scheduled time already past, outside the window, waits for the window", () => {
  const night = new Date("2026-10-23T20:00:00Z");
  const past = new Date(night.getTime() - 3600_000).toISOString();
  const wait = nextWaitMs({ ...idle, next_scheduled_at: past }, dayWindow, night);
  assert.ok(wait > 6 * 3600_000 && wait <= MAX_WAIT_MS);
});

test("only in-flight rows left: poll again in about a minute", () => {
  assert.equal(nextWaitMs({ ...idle, in_flight: true }, alwaysOpen, now), 60_000);
});

test("a window that never opens falls back to an hourly check, never a tight loop", () => {
  const wait = nextWaitMs({ ...idle, running_pending: true }, neverOpen, now);
  assert.equal(wait, 3600_000);
});
