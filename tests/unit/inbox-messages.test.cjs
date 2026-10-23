const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

function loadTypeScript(file, dependencies) {
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const fallbackRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => dependencies[specifier] ?? fallbackRequire(specifier);
  loaded._compile(output, file);
  return loaded.exports;
}

class MetaApiError extends Error {
  constructor(message, category, options = {}) {
    super(message);
    this.category = category;
    this.definitiveRejection = options.definitiveRejection ?? false;
  }
}

function load(post) {
  const calls = [];
  const client = {
    MetaApiError,
    getConfiguredMetaIdentifiers: () => ({ wabaId: "W1", phoneNumberId: "P1", appId: null }),
    metaGraphPost: async (route, body) => { calls.push({ route, body }); return post(route, body); },
  };
  const messages = loadTypeScript(path.resolve(__dirname, "../../src/server/meta/messages.ts"), { "./client": client });
  return { messages, calls };
}

test("sends a plain text message to the configured sender and returns the wamid", async () => {
  const { messages, calls } = load(async () => ({ messages: [{ id: "wamid.ABC" }] }));
  const result = await messages.sendTextReply({ toWaId: "15551234567", body: "  Hello  " });
  assert.equal(result.messageId, "wamid.ABC");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, "P1/messages");
  assert.deepEqual(calls[0].body, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "15551234567",
    type: "text",
    text: { preview_url: false, body: "Hello" },
  });
});

test("rejects invalid recipients and bodies before any network call", async () => {
  const { messages, calls } = load(async () => ({ messages: [{ id: "wamid.X" }] }));
  for (const input of [
    { toWaId: "+15551234567", body: "hi" },
    { toWaId: "abc", body: "hi" },
    { toWaId: "15551234567", body: "   " },
    { toWaId: "15551234567", body: "x".repeat(4097) },
  ]) {
    await assert.rejects(() => messages.sendTextReply(input), (error) =>
      error instanceof MetaApiError && error.definitiveRejection === true && error.category === "validation");
  }
  assert.equal(calls.length, 0);
});

test("accepts exactly 4096 characters", async () => {
  const { messages } = load(async () => ({ messages: [{ id: "wamid.LONG" }] }));
  assert.equal((await messages.sendTextReply({ toWaId: "15551234567", body: "x".repeat(4096) })).messageId, "wamid.LONG");
});

test("a 200 response without a usable wamid is an uncertain outcome, not a success", async () => {
  for (const response of [{}, { messages: [] }, { messages: [{}] }, { messages: [{ id: "not-a-wamid" }] }]) {
    const { messages } = load(async () => response);
    await assert.rejects(() => messages.sendTextReply({ toWaId: "15551234567", body: "hi" }), (error) =>
      error instanceof MetaApiError && error.category === "response" && error.definitiveRejection === false);
  }
});

test("provider errors from the client propagate unchanged for outcome classification", async () => {
  const boom = new MetaApiError("Meta returned an uncertain response with HTTP 503.", "provider", { definitiveRejection: false });
  const { messages } = load(async () => { throw boom; });
  await assert.rejects(() => messages.sendTextReply({ toWaId: "15551234567", body: "hi" }), (error) => error === boom);
});
