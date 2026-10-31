const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const ts = require("typescript");

const file = path.resolve(__dirname, "../../src/server/inbox/retention.ts");
const out = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const m = new Module(file, module);
m.filename = file;
m._compile(out, file);
const { parseRetentionDays, retentionCutoff, isAuthorizedCron } = m.exports;

test("retention defaults to 90 days and rejects unsafe values", () => {
  assert.equal(parseRetentionDays(undefined), 90);
  assert.equal(parseRetentionDays(""), 90);
  assert.equal(parseRetentionDays("abc"), 90);
  assert.equal(parseRetentionDays("7"), 90);
  assert.equal(parseRetentionDays("12.5"), 90);
  assert.equal(parseRetentionDays("120"), 120);
});

test("cutoff is exactly N days before now", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  assert.equal(retentionCutoff(90, now).toISOString(), "2026-08-02T00:00:00.000Z");
});

test("cron auth needs a long secret and the exact bearer header", () => {
  const eq = (a, b) => a === b;
  const secret = "a-very-long-secret-1234";
  assert.equal(isAuthorizedCron(`Bearer ${secret}`, secret, eq), true);
  assert.equal(isAuthorizedCron("Bearer nope", secret, eq), false);
  assert.equal(isAuthorizedCron(null, secret, eq), false);
  assert.equal(isAuthorizedCron("Bearer short", "short", eq), false);
  assert.equal(isAuthorizedCron(`Bearer ${secret}`, undefined, eq), false);
});
