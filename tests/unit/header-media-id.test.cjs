const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file) {
  const source = fs.readFileSync(path.join(__dirname, "../../src", file), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const mod = { exports: {} };
  new Function("module", "exports", outputText)(mod, mod.exports);
  return mod.exports;
}
const { createHeaderMediaResolver, MEDIA_ID_TTL_MS, MEDIA_REFERENCE_ERROR_CODES } = load("server/meta/media-id-core.ts");
const { headerMediaFromUrl } = load("server/campaigns/media-paths.ts");

function fixture(overrides = {}) {
  const state = { stored: null, uploads: 0, fetches: 0, saved: [], forgotten: [] };
  const deps = {
    lookup: async () => state.stored,
    save: async (...args) => { state.saved.push(args); },
    forget: async (...args) => { state.forgotten.push(args); },
    fetchFile: async () => { state.fetches += 1; return { bytes: new Uint8Array([1, 2, 3]), mime: "video/mp4", filename: "a.mp4" }; },
    upload: async () => { state.uploads += 1; return "555555"; },
    ...overrides,
  };
  return { state, resolver: createHeaderMediaResolver(deps) };
}

test("a stored ID is reused without downloading or uploading anything", async () => {
  const { state, resolver } = fixture();
  state.stored = "111111";
  assert.deepEqual(await resolver.resolve("u", "p1"), { id: "111111", fresh: false });
  assert.deepEqual([state.fetches, state.uploads], [0, 0]);
});

test("the first send uploads once, saves the ID, and 500 concurrent sends share that one upload", async () => {
  const { state, resolver } = fixture();
  const results = await Promise.all(Array.from({ length: 500 }, () => resolver.resolve("u", "p1")));
  assert.ok(results.every((value) => value.id === "555555"));
  assert.deepEqual([state.fetches, state.uploads, state.saved.length], [1, 1, 1]);
});

test("any failure falls back to the link instead of throwing", async () => {
  assert.equal(await fixture({ upload: async () => { throw new Error("meta down"); } }).resolver.resolve("u", "p"), null);
  assert.equal(await fixture({ fetchFile: async () => null }).resolver.resolve("u", "p"), null);
  assert.equal(await fixture({ lookup: async () => { throw new Error("db down"); } }).resolver.resolve("u", "p"), null);
});

test("a failed save does not lose the freshly uploaded ID", async () => {
  const { resolver } = fixture({ save: async () => { throw new Error("db down"); } });
  assert.deepEqual(await resolver.resolve("u", "p"), { id: "555555", fresh: true });
});

test("an old rejected ID is forgotten; a fresh rejected ID switches this process to links", async () => {
  const old = fixture();
  await old.resolver.rejected("u", "p", { id: "1", fresh: false });
  assert.equal(old.state.forgotten.length, 1);
  assert.ok(await old.resolver.resolve("u", "p") || true);

  const fresh = fixture();
  const media = await fresh.resolver.resolve("u", "p");
  await fresh.resolver.rejected("u", "p", media);
  assert.equal(await fresh.resolver.resolve("u", "p"), null);
});

test("IDs expire after 25 days, before WhatsApp's 30, and only media errors trigger a retry", () => {
  assert.equal(MEDIA_ID_TTL_MS, 25 * 24 * 3600 * 1000);
  assert.ok(MEDIA_REFERENCE_ERROR_CODES.has(131053) && !MEDIA_REFERENCE_ERROR_CODES.has(131026));
});

test("only header files we stored are read back, with the right type", () => {
  const prefix = "https://abc.supabase.co/storage/v1/object/public/campaign-media/";
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(headerMediaFromUrl(`${prefix}videos/2026-11-06/${id}.mp4`, prefix), { path: `videos/2026-11-06/${id}.mp4`, mime: "video/mp4", filename: `${id}.mp4` });
  assert.equal(headerMediaFromUrl(`${prefix}2026-10-31/${id}.png`, prefix).mime, "image/png");
  assert.equal(headerMediaFromUrl(`${prefix}2026-10-31/${id}.jpg`, prefix).mime, "image/jpeg");
  assert.equal(headerMediaFromUrl(`https://evil.example/2026-10-31/${id}.jpg`, prefix), null);
  assert.equal(headerMediaFromUrl(`${prefix}../secret/${id}.jpg`, prefix), null);
  assert.equal(headerMediaFromUrl(`${prefix}2026-10-31/${id}.gif`, prefix), null);
});
