const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/server/campaigns/retry-explain.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
new Function("module", "exports", outputText)(mod, mod.exports);
const { explainRetry, describeExclusion } = mod.exports;

const NOW = new Date("2026-11-03T10:00:00Z");
const row = (over) => ({ retryStatus: "not_retryable", errorCode: "131049", attemptsMade: 0, retryReadyAt: null, contactStatus: "active", contactReason: null, ...over });

test("a message that can be retried now has no blocking reason", () => {
  assert.equal(explainRetry(row({ retryStatus: "eligible", retryReadyAt: "2026-11-03T09:00:00Z" }), NOW), null);
});

test("a message inside its waiting time says when it becomes eligible", () => {
  const text = explainRetry(row({ retryStatus: "eligible", retryReadyAt: "2026-11-04T09:00:00Z" }), NOW);
  assert.match(text, /Eligible from 2026-11-04 09:00 UTC/);
});

test("recovered, pending, exhausted and stopped each get their own explanation", () => {
  assert.match(explainRetry(row({ retryStatus: "recovered" })), /Delivered after a retry/);
  assert.match(explainRetry(row({ retryStatus: "pending" })), /already queued/);
  assert.match(explainRetry(row({ retryStatus: "exhausted" })), /Do Not Send/);
  assert.match(explainRetry(row({ retryStatus: "stopped" })), /not repeated/);
});

test("contact-level blocks are explained and Global Opt Out is never retried", () => {
  assert.match(explainRetry(row({ contactStatus: "opt_out" })), /Global Opt Out/);
  assert.match(explainRetry(row({ contactStatus: "do_not_send", contactReason: "retry_exhausted" })), /3 retries failed/);
  assert.match(explainRetry(row({ contactStatus: "do_not_send", contactReason: "undeliverable_131026" })), /Verify the number/);
});

test("error codes outside 131049 explain how they are handled", () => {
  assert.match(explainRetry(row({ errorCode: "131026" })), /never retried/);
  assert.match(explainRetry(row({ errorCode: "131050" })), /Global Opt Out/);
  assert.match(explainRetry(row({ errorCode: "131048" })), /business number/);
  assert.match(explainRetry(row({ errorCode: "131056" })), /cooldown/);
  assert.match(explainRetry(row({ errorCode: "131047" })), /approved template/);
  assert.match(explainRetry(row({ errorCode: "999999" })), /not retried automatically/);
});

test("new-campaign exclusion codes read as plain words", () => {
  assert.equal(describeExclusion(null), "Eligible");
  assert.match(describeExclusion("waiting_131049"), /24 hour wait/);
  assert.match(describeExclusion("global_opt_out"), /Global Opt Out/);
  assert.match(describeExclusion("hold_something_new"), /Do Not Send/);
  assert.equal(describeExclusion("brand_new_code"), "Not eligible");
});
