const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const ts = require("typescript");

const file = path.resolve(__dirname, "../../src/server/dashboard/adjustments-math.ts");
const out = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const m = new Module(file, module);
m.filename = file;
m._compile(out, file);
const { parseMetaTotal, offsetFromMetaTotal, emptyAdjustments, MAX_METRIC_TOTAL } = m.exports;

test("parses whole numbers, ignoring commas and spaces", () => {
  assert.deepEqual(parseMetaTotal("1,234"), { kind: "ok", total: 1234 });
  assert.deepEqual(parseMetaTotal(" 12 000 "), { kind: "ok", total: 12000 });
  assert.deepEqual(parseMetaTotal("0"), { kind: "ok", total: 0 });
});

test("blank means no adjustment", () => {
  assert.deepEqual(parseMetaTotal(""), { kind: "blank" });
  assert.deepEqual(parseMetaTotal("   "), { kind: "blank" });
});

test("rejects decimals, negatives, text, huge numbers and non-strings", () => {
  for (const bad of ["12.5", "-3", "abc", "1e5", "1234567890", String(MAX_METRIC_TOTAL + 1)]) {
    assert.deepEqual(parseMetaTotal(bad), { kind: "invalid" }, bad);
  }
  assert.deepEqual(parseMetaTotal(null), { kind: "invalid" });
  assert.deepEqual(parseMetaTotal(undefined), { kind: "invalid" });
  assert.deepEqual(parseMetaTotal(5), { kind: "invalid" });
});

test("offset makes database + offset equal Meta's total", () => {
  assert.equal(offsetFromMetaTotal(1500, 529), 971);
  assert.equal(offsetFromMetaTotal(529, 529), 0);
});

test("Meta total below the database count is refused", () => {
  assert.equal(offsetFromMetaTotal(500, 529), null);
});

test("empty adjustments are all zero", () => {
  assert.deepEqual(emptyAdjustments(), { messages_sent: 0, messages_delivered: 0, marketing: 0, utility: 0, authentication: 0 });
});
