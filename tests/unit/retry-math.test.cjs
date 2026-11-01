const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/server/campaigns/retry-math.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
new Function("module", "exports", outputText)(mod, mod.exports);
const { parseRetryDelays, describeDelay, csvCell, DEFAULT_RETRY_DELAYS_HOURS } = mod.exports;

test("defaults are 24h, 72h and 7 days", () => {
  assert.deepEqual([...DEFAULT_RETRY_DELAYS_HOURS], [24, 72, 168]);
});

test("accepts three increasing whole-hour delays", () => {
  assert.deepEqual(parseRetryDelays(["24", "72", "168"]), { ok: true, delays: [24, 72, 168] });
  assert.deepEqual(parseRetryDelays([" 1 ", "2", "720"]), { ok: true, delays: [1, 2, 720] });
});

test("rejects wrong counts, non-numbers, zero, equal or shrinking delays and more than 30 days", () => {
  for (const bad of [["24", "72"], ["24", "72", "168", "200"], ["a", "2", "3"], ["", "2", "3"], ["1.5", "2", "3"],
    ["-1", "2", "3"], ["0", "2", "3"], ["24", "24", "48"], ["72", "24", "168"], ["1", "2", "721"], [24, 72, 168], ["1e2", "200", "300"]]) {
    assert.equal(parseRetryDelays(bad).ok, false, JSON.stringify(bad));
  }
});

test("describes delays", () => {
  assert.equal(describeDelay(1), "1 hour");
  assert.equal(describeDelay(24), "24 hours");
  assert.equal(describeDelay(72), "3 days");
  assert.equal(describeDelay(168), "7 days");
  assert.equal(describeDelay(50), "50 hours");
});

test("csv cells are quoted and neutralise spreadsheet formulas", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("=HYPERLINK(1)"), `"'=HYPERLINK(1)"`);
  assert.equal(csvCell("+16470000000"), `"'+16470000000"`);
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(131049), '"131049"');
});
