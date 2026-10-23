const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");

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

const bytes = (value) => Buffer.from(value, "utf8");

test("national numbers require an explicit country and impossible numbers stay invalid", () => {
  assert.equal(phone.normalizeContactPhone("(416) 555-0123").code, "country_code_required");
  assert.deepEqual(phone.normalizeContactPhone("(416) 555-0123", "CA"), {
    ok: true,
    e164: "+14165550123",
  });
  assert.equal(phone.normalizeContactPhone("+1 111 111 1111").code, "invalid_phone");
  assert.equal(phone.normalizeContactPhone("Call me +14165550123").code, "country_code_required");
});

test("CSV preview maps headers, rejects duplicates, and keeps imported consent pending", async () => {
  const csv = '\uFEFFTitle,Number,Consent,Evidence,Consent Time\n"A, One",+14165550123,yes,form-17,2026-01-15T10:30:00-05:00\nTwo,(416) 555-0123,yes,,2026-01-15\nThree,+447911123456,no,,\n';
  const parsed = await file.parseContactFile({ fileName: "customers.csv", bytes: bytes(csv) });
  const result = preview.previewContactImport(parsed, {
    phoneColumn: "Number", nameColumn: "Title", consentColumn: "Consent",
    evidenceColumn: "Evidence", consentOccurredAtColumn: "Consent Time", defaultCountry: "CA",
  });
  assert.equal(parsed.headers[0], "Title");
  assert.equal(result.rows[0].displayName, "A, One");
  assert.equal(result.rows[0].consentOccurredAt, "2026-01-15T15:30:00.000Z");
  assert.equal(result.rows[0].consentClaimed, true);
  assert.ok(result.rows[0].warnings.some((item) => item.includes("pending")));
  assert.equal(result.rows[1].phoneE164, "+14165550123");
  assert.deepEqual(result.errors.map((item) => item.code), ["duplicate_in_file"]);
  assert.equal(result.stats.validRows, 2);
  assert.equal(result.stats.pendingConsentClaims, 1);
  assert.equal(result.stats.negativeConsentRows, 1);
  assert.equal(result.validRows[0].evidence_reference, "form-17");
  assert.equal(result.validRows[0].consent_claimed, true);
  assert.equal(result.validRows[1].consent_explicit_no, true);
  assert.equal(result.rows[2].consentExplicitNo, true);
});

test("unknown consent markers and timezone-free datetimes never produce a reviewable claim", async () => {
  const parsed = await file.parseContactFile({
    fileName: "list.csv",
    bytes: bytes("Name,Phone,Consent,Time\nAda,+14165550123,maybe,2026-01-15\nBea,+447911123456,yes,2026-01-15T10:00:00\n"),
  });
  const result = preview.previewContactImport(parsed, {
    phoneColumn: 1, nameColumn: 0, consentColumn: 2, consentOccurredAtColumn: 3,
  });
  assert.equal(result.validRows[0].consent_claimed, false);
  assert.equal(result.validRows[0].consent_explicit_no, false);
  assert.equal(result.validRows[1].consent_claimed, true);
  assert.equal(result.validRows[1].consent_occurred_at, null);
  assert.equal(result.stats.claimsMissingTimestamp, 1);
});

test("blank and unknown consent stay neutral, while explicit negatives suppress even on duplicate phones", async () => {
  const parsed = await file.parseContactFile({
    fileName: "mixed.csv",
    bytes: bytes("Name,Phone,Consent\nEarly Yes,+14165550123,yes\nLater No,+14165550123,opted out\nBlank,+447911123456,\nUnknown,+33612345678,maybe\nLong name that is intentionally more than one hundred and sixty characters long so that the imported opt out must not be lost due to contact display name formatting errors in this spreadsheet,+61491570156,false\n"),
  });
  const result = preview.previewContactImport(parsed, { phoneColumn: "Phone", nameColumn: "Name", consentColumn: "Consent" });
  assert.equal(result.stats.negativeConsentRows, 2);
  assert.equal(result.stats.duplicateRows, 1);
  assert.equal(result.rows[0].errors.length, 1);
  assert.equal(result.rows[1].consentExplicitNo, true);
  assert.equal(result.validRows.find((row) => row.phone_e164 === "+14165550123").consent_explicit_no, true);
  assert.equal(result.validRows.find((row) => row.phone_e164 === "+447911123456").consent_explicit_no, false);
  assert.equal(result.validRows.find((row) => row.phone_e164 === "+33612345678").consent_explicit_no, false);
  assert.equal(result.validRows.find((row) => row.phone_e164 === "+61491570156").display_name, null);
});

test("Excel uses the chosen sheet and preserves date-only consent precision", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Notes").addRow(["Ignore", "This"]);
  const contacts = workbook.addWorksheet("Contacts");
  contacts.addRow(["Title", "Number", "Consent", "Consent time"]);
  contacts.addRow(["Ada", "+14165550123", "yes", new Date("2026-01-15T15:30:00.000Z")]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await file.parseContactFile({ fileName: "contacts.xlsx", bytes: buffer, sheetName: "Contacts" });
  const result = preview.previewContactImport(parsed, {
    phoneColumn: "Number", nameColumn: "Title", consentColumn: "Consent",
    consentOccurredAtColumn: "Consent time",
  });
  assert.equal(parsed.sourceLabel, "Contacts");
  assert.deepEqual(parsed.sheetNames, ["Notes", "Contacts"]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(result.validRows[0].phone_e164, "+14165550123");
  assert.equal(parsed.rows[0].cells[3], "2026-01-15");
  assert.equal(result.validRows[0].consent_occurred_on, "2026-01-15");
  assert.equal(result.validRows[0].consent_occurred_at, "2026-01-14T10:00:00.000Z");
  assert.equal(result.stats.dateOnlyConsentClaims, 1);
  assert.equal(result.stats.claimsAwaitingDateReview, 0);
});

test("date-only consent from CSV stays pending and future dates are not accepted as evidence", async () => {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const parsed = await file.parseContactFile({
    fileName: "dates.csv",
    bytes: bytes(`Phone,Consent,Date\n+14165550123,yes,2026-01-15\n+447911123456,yes,2099-01-01\n+61491570156,yes,${todayUtc}\n`),
  });
  const result = preview.previewContactImport(parsed, {
    phoneColumn: "Phone", consentColumn: "Consent", consentOccurredAtColumn: "Date",
  });
  assert.equal(result.validRows[0].consent_occurred_on, "2026-01-15");
  assert.equal(result.validRows[0].consent_occurred_at, "2026-01-14T10:00:00.000Z");
  assert.equal(result.validRows[1].consent_occurred_on, null);
  assert.equal(result.validRows[1].consent_occurred_at, null);
  assert.equal(result.stats.claimsMissingTimestamp, 1);
  assert.equal(result.stats.dateOnlyConsentClaims, 2);
  assert.equal(result.stats.claimsAwaitingDateReview, 1);
});

test("Excel auto-selects the first valid visible table after an invalid cover sheet", async () => {
  const workbook = new ExcelJS.Workbook();
  const cover = workbook.addWorksheet("Instructions");
  cover.addRow(["Read this first"]);
  cover.addRow(["Export the Contacts tab"]);
  const contacts = workbook.addWorksheet("Contacts");
  contacts.addRow(["Title", "Number"]);
  contacts.addRow(["Ada", "+14165550123"]);
  workbook.addWorksheet("Empty tab");
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await file.parseContactFile({ fileName: "contacts.xlsx", bytes: buffer });
  assert.equal(parsed.sourceLabel, "Contacts");
  assert.deepEqual(parsed.sheetNames, ["Instructions", "Contacts", "Empty tab"]);
  assert.equal(parsed.rows.length, 1);
  // Explicitly choosing a one-column sheet is allowed: a phone-number-only list is a valid import.
  const cover_only = await file.parseContactFile({ fileName: "contacts.xlsx", bytes: buffer, sheetName: "Instructions" });
  assert.deepEqual(cover_only.headers, ["Read this first"]);
  assert.equal(cover_only.rows.length, 1);
  await assert.rejects(
    file.parseContactFile({ fileName: "contacts.xlsx", bytes: buffer, sheetName: "Empty tab" }),
    (error) => error.code === "invalid_file",
  );
});

test("a CSV with only one column (a phone-number header) can be imported", async () => {
  const parsed = await file.parseContactFile({
    fileName: "one_contact.csv",
    bytes: Buffer.from("\uFEFFto\n+14165550123\n+14165550124\n", "utf8"),
  });
  assert.deepEqual(parsed.headers, ["to"]);
  assert.equal(parsed.rows.length, 2);
});

test("an empty file or a blank header row is still rejected", async () => {
  // A zero-byte file fails the size check; blank or comma-only headers fail header validation.
  for (const text of ["", "\n\n", ",\n+14165550123,\n"]) {
    await assert.rejects(
      file.parseContactFile({ fileName: "x.csv", bytes: Buffer.from(text, "utf8") }),
      (error) => error.name === "ContactImportError" && typeof error.code === "string",
    );
  }
});

test("an Excel workbook whose only sheet has one column is accepted", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Numbers");
  sheet.addRow(["to"]);
  sheet.addRow(["+14165550123"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await file.parseContactFile({ fileName: "numbers.xlsx", bytes: buffer });
  assert.deepEqual(parsed.headers, ["to"]);
  assert.equal(parsed.rows.length, 1);
});

test("Word tables with split text runs and column headers can be imported", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>Title</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Number</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>da</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>+14165550123</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl></w:body></w:document>`);
  const parsed = await file.parseContactFile({
    fileName: "contacts.docx", bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  });
  const result = preview.previewContactImport(parsed, { phoneColumn: "Number", nameColumn: "Title" });
  assert.equal(parsed.sourceLabel, "Table 1");
  assert.equal(result.validRows[0].display_name, "Ada");
});

test("file, row, and archive expansion limits are enforced before import", async () => {
  await assert.rejects(
    file.parseContactFile({ fileName: "contacts.csv", bytes: Buffer.alloc(types.MAX_CONTACT_FILE_BYTES + 1) }),
    (error) => error.code === "file_size",
  );
  const manyRows = "Name,Phone\n" + "Ada,+14165550123\n".repeat(5001);
  await assert.rejects(
    file.parseContactFile({ fileName: "contacts.csv", bytes: bytes(manyRows) }),
    (error) => error.code === "row_limit",
  );
  const zip = new JSZip();
  zip.file("word/document.xml", "A".repeat(12 * 1024 * 1024));
  const compressed = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await assert.rejects(
    file.parseContactFile({ fileName: "bomb.docx", bytes: compressed }),
    (error) => error.code === "invalid_file",
  );
});
