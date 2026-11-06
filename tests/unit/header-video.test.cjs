const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/server/campaigns/media-paths.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
new Function("module", "exports", outputText)(mod, mod.exports);
const { headerVideoPath, headerVideoPathFromUrl, MAX_HEADER_VIDEO_BYTES } = mod.exports;

const PREFIX = "https://abc.supabase.co/storage/v1/object/public/campaign-media/";
const ID = "123e4567-e89b-42d3-a456-426614174000";

test("a header video lives under videos/<day>/<uuid>.mp4 and the size limit is 16 MB", () => {
  assert.equal(headerVideoPath("2026-11-04", ID), `videos/2026-11-04/${ID}.mp4`);
  assert.equal(MAX_HEADER_VIDEO_BYTES, 16 * 1024 * 1024);
});

test("only a video link we created is accepted", () => {
  const good = `${PREFIX}videos/2026-11-04/${ID}.mp4`;
  assert.equal(headerVideoPathFromUrl(good, PREFIX), `videos/2026-11-04/${ID}.mp4`);
});

test("other links, images, other files and path tricks are refused", () => {
  assert.equal(headerVideoPathFromUrl(`https://evil.example/videos/2026-11-04/${ID}.mp4`, PREFIX), null);
  assert.equal(headerVideoPathFromUrl(`${PREFIX}2026-11-04/${ID}.jpg`, PREFIX), null);
  assert.equal(headerVideoPathFromUrl(`${PREFIX}videos/2026-11-04/${ID}.mov`, PREFIX), null);
  assert.equal(headerVideoPathFromUrl(`${PREFIX}videos/2026-11-04/../../x/${ID}.mp4`, PREFIX), null);
  assert.equal(headerVideoPathFromUrl(`${PREFIX}videos/2026-11-04/${ID}.mp4?x=1`, PREFIX), null);
  assert.equal(headerVideoPathFromUrl("", PREFIX), null);
});
