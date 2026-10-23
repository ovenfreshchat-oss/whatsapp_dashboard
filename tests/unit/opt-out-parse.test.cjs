const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

function loadTypeScript(file, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => dependencies[specifier] ?? originalRequire(specifier);
  loaded._compile(output, file);
  return loaded.exports;
}

const server = path.resolve(__dirname, "../../src/server");
const phone = loadTypeScript(path.join(server, "imports/phone.ts"));
const { parseOptOutInput, MAX_OPT_OUT_NUMBERS } = loadTypeScript(path.join(server, "opt-outs/parse.ts"), {
  "../imports/phone": phone,
});

test("normalizes numbers separated by newlines, commas, semicolons and tabs", () => {
  const r = parseOptOutInput("+919746298851\n+968 9123 4567, +14155552671;+442071838750\t+919746298852");
  assert.equal(r.numbers.length, 5);
  assert.ok(r.numbers.every((n) => /^\+[1-9]\d{7,14}$/.test(n)));
  assert.equal(r.rejected.length, 0);
});

test("dedupes the same number written in different formats", () => {
  const r = parseOptOutInput("+91 97462 98851\n+919746298851\n+91-97462-98851");
  assert.deepEqual(r.numbers, ["+919746298851"]);
  assert.equal(r.duplicates, 2);
});

test("rejects numbers without + unless a default country is given", () => {
  const without = parseOptOutInput("9746298851");
  assert.equal(without.numbers.length, 0);
  assert.equal(without.rejected[0].line, 1);
  const withCountry = parseOptOutInput("9746298851", "IN");
  assert.deepEqual(withCountry.numbers, ["+919746298851"]);
});

test("reports invalid values with their line and keeps the valid ones", () => {
  const r = parseOptOutInput("+919746298851\nnot a number\n\n+1234\n+14155552671");
  assert.equal(r.numbers.length, 2);
  assert.deepEqual(r.rejected.map((x) => x.line), [2, 4]);
});

test("handles CRLF, blank input, and flags oversized input", () => {
  assert.equal(parseOptOutInput("\r\n  \r\n").numbers.length, 0);
  assert.equal(parseOptOutInput("+919746298851\r\n+14155552671").numbers.length, 2);
  const many = Array.from({ length: MAX_OPT_OUT_NUMBERS + 1 }, (_, i) => `+9198${String(10000000 + i)}`).join("\n");
  assert.equal(parseOptOutInput(many).tooMany, true);
});
