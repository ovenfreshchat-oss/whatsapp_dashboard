const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const ExcelJS = require("exceljs");

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

const directory = path.resolve(__dirname, "../../src/server/imports");
const types = loadTypeScript(path.join(directory, "types.ts"));
const phone = loadTypeScript(path.join(directory, "phone.ts"));
const file = loadTypeScript(path.join(directory, "file.ts"), { "./types": types });
const preview = loadTypeScript(path.join(directory, "preview.ts"), { "./types": types, "./phone": phone });
const skippedModule = loadTypeScript(path.join(directory, "skipped.ts"), {});

/** 40 rows: 13 good numbers and 27 that must be skipped, for three different reasons. */
async function workbookWith27Skipped() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Contacts");
  sheet.addRow(["Name", "Phone number"]);
  for (let i = 0; i < 13; i += 1) sheet.addRow([`Good ${i}`, `+9715000000${String(10 + i)}`.replace(/^(\+971)5000000/, "$15012345")]);
  // 10 numbers with no country code
  for (let i = 0; i < 10; i += 1) sheet.addRow([`No code ${i}`, `98765${String(10000 + i)}`]);
  // 9 numbers that are not valid
  for (let i = 0; i < 9; i += 1) sheet.addRow([`Bad ${i}`, `+1 111 111 11${String(10 + i)}`]);
  // 8 blank phone cells (the name is present, so the row is not empty)
  for (let i = 0; i < 8; i += 1) sheet.addRow([`Blank ${i}`, ""]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("an Excel file with 27 skipped rows lists all 27, each with a reason", async () => {
  const bytes = await workbookWith27Skipped();
  const parsed = await file.parseContactFile({ fileName: "contacts.xlsx", bytes });
  const result = preview.previewContactImport(parsed, { phoneColumn: 1, nameColumn: 0 });
  const skipped = skippedModule.listSkippedRows(result);

  assert.equal(result.stats.invalidRows, 27);
  assert.equal(skipped.length, 27, "the list must have exactly as many rows as the skipped count");
  assert.equal(result.stats.validRows, 13);
  assert.ok(skipped.every((row) => row.reasons.length > 0 && row.reasons.every((reason) => reason.length > 3)));
  assert.equal(new Set(skipped.map((row) => row.rowNumber)).size, 27, "no row is listed twice");

  const reasons = skippedModule.countSkipReasons(skipped);
  const byCode = Object.fromEntries(reasons.map((item) => [item.code, item.count]));
  assert.equal(byCode.country_code_required, 10);
  assert.equal(byCode.invalid_phone, 9);
  assert.equal(byCode.missing_phone, 8);
  assert.equal(reasons.reduce((sum, item) => sum + item.count, 0), 27);
});

test("choosing a default country rescues numbers that only lacked a country code", async () => {
  const bytes = await workbookWith27Skipped();
  const parsed = await file.parseContactFile({ fileName: "contacts.xlsx", bytes });
  const result = preview.previewContactImport(parsed, { phoneColumn: 1, nameColumn: 0, defaultCountry: "IN" });
  const skipped = skippedModule.listSkippedRows(result);
  assert.equal(result.stats.invalidRows, skipped.length);
  assert.ok(skipped.length < 27);
  assert.ok(!skipped.some((row) => row.codes.includes("country_code_required")));
});

test("duplicates and over-long names are listed with their own reasons", async () => {
  const parsed = {
    fileName: "dupes.csv", fileKind: "csv", fileSha256: "0".repeat(64), sourceLabel: "CSV",
    headers: ["Name", "Phone"],
    rows: [
      { rowNumber: 2, cells: ["A", "+14165550123"] },
      { rowNumber: 3, cells: ["B", "+14165550123"] },
      { rowNumber: 4, cells: ["x".repeat(200), "+14165550124"] },
      { rowNumber: 5, cells: ["C", "+14165550125"] },
    ],
  };
  const result = preview.previewContactImport(parsed, { phoneColumn: 1, nameColumn: 0 });
  const skipped = skippedModule.listSkippedRows(result);
  assert.deepEqual(skipped.map((row) => [row.rowNumber, row.codes[0]]), [[3, "duplicate_in_file"], [4, "name_too_long"]]);
  assert.equal(result.stats.validRows, 2);
});

test("a row with two problems is listed once and counted once", () => {
  const parsed = {
    fileName: "two.csv", fileKind: "csv", fileSha256: "0".repeat(64), sourceLabel: "CSV",
    headers: ["Name", "Phone"],
    rows: [{ rowNumber: 2, cells: ["x".repeat(200), "12345"] }],
  };
  const result = preview.previewContactImport(parsed, { phoneColumn: 1, nameColumn: 0 });
  const skipped = skippedModule.listSkippedRows(result);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reasons.length, 2);
  assert.equal(result.stats.invalidRows, 1);
});
