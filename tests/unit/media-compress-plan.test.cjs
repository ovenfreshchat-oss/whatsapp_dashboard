const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/lib/media-compress-plan.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
new Function("module", "exports", outputText)(mod, mod.exports);
const { planVideoCompression, worthKeeping, planImageSize, formatSize, MB } = mod.exports;

test("a small video is left alone", () => {
  assert.equal(planVideoCompression({ width: 1280, height: 720, durationSeconds: 10, sizeBytes: 1.5 * MB }), null);
});

test("the 13.4 MB 1080p clip is scaled to 720p and lands under the 8 MB target", () => {
  const plan = planVideoCompression({ width: 1920, height: 1080, durationSeconds: 20, sizeBytes: 13.39 * MB });
  assert.deepEqual([plan.width, plan.height], [1280, 720]);
  assert.ok(plan.estimatedBytes < 8 * MB && plan.estimatedBytes < 13.39 * MB * 0.6, String(plan.estimatedBytes));
  assert.ok(plan.videoBitrate >= 500_000);
});

test("a portrait video is scaled by its short edge and keeps even dimensions", () => {
  const plan = planVideoCompression({ width: 1080, height: 1920, durationSeconds: 15, sizeBytes: 12 * MB });
  assert.deepEqual([plan.width, plan.height], [720, 1280]);
  assert.equal(plan.width % 2 + plan.height % 2, 0);
});

test("a video already under 720p is not enlarged", () => {
  const plan = planVideoCompression({ width: 640, height: 360, durationSeconds: 30, sizeBytes: 9 * MB });
  assert.deepEqual([plan.width, plan.height], [640, 360]);
});

test("a source that is already low bitrate is not re-encoded", () => {
  assert.equal(planVideoCompression({ width: 1920, height: 1080, durationSeconds: 60, sizeBytes: 3 * MB }), null);
});

test("the bitrate never exceeds what the source already has", () => {
  const plan = planVideoCompression({ width: 1920, height: 1080, durationSeconds: 20, sizeBytes: 5 * MB });
  assert.ok(plan.videoBitrate <= (5 * MB * 8) / 20);
});

test("a long clip is squeezed to fit the budget, and bad input is refused", () => {
  const plan = planVideoCompression({ width: 1920, height: 1080, durationSeconds: 120, sizeBytes: 150 * MB });
  assert.ok(plan.estimatedBytes <= 9.5 * MB && plan.estimatedBytes < 16 * MB, String(plan.estimatedBytes));
  assert.equal(planVideoCompression({ width: 0, height: 720, durationSeconds: 10, sizeBytes: 5 * MB }), null);
  assert.equal(planVideoCompression({ width: 1280, height: 720, durationSeconds: NaN, sizeBytes: 5 * MB }), null);
});

test("a result is kept only when at least 10% smaller", () => {
  assert.equal(worthKeeping(10 * MB, 2 * MB), true);
  assert.equal(worthKeeping(10 * MB, 9.5 * MB), false);
  assert.equal(worthKeeping(10 * MB, 0), false);
});

test("images are only scaled down when bigger than 1600 px", () => {
  assert.deepEqual(planImageSize(800, 418), { width: 800, height: 418 });
  assert.deepEqual(planImageSize(3200, 1676), { width: 1600, height: 838 });
  assert.deepEqual(planImageSize(1200, 3000), { width: 640, height: 1600 });
});

test("sizes read in MB or KB", () => {
  assert.equal(formatSize(13.39 * MB), "13.4 MB");
  assert.equal(formatSize(820 * 1024), "820 KB");
});
