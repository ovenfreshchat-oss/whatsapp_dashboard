const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const Module = require("node:module");
const ts = require("typescript");

const file = path.resolve(__dirname, "../../src/server/auth/staff-users/roles.ts");
const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(file, module);
loaded.filename = file;
loaded._compile(output, file);
const { parseAdminEmails, resolveWorkspaceRole } = loaded.exports;

const admins = parseAdminEmails(" Owner@Example.com , second@example.com,, ");

test("admin emails are trimmed, lower-cased and empty entries dropped", () => {
  assert.deepEqual([...admins].sort(), ["owner@example.com", "second@example.com"]);
  assert.equal(parseAdminEmails(undefined).size, 0);
});

test("admin email wins regardless of case or metadata", () => {
  assert.equal(resolveWorkspaceRole("OWNER@example.com", {}, admins), "admin");
  assert.equal(resolveWorkspaceRole("owner@example.com", { role: "staff" }, admins), "admin");
});

test("account created from the Team page is staff", () => {
  assert.equal(resolveWorkspaceRole("nurse@example.com", { role: "staff" }, admins), "staff");
});

test("no role, other roles or malformed metadata get no access", () => {
  assert.equal(resolveWorkspaceRole("x@example.com", {}, admins), null);
  assert.equal(resolveWorkspaceRole("x@example.com", undefined, admins), null);
  assert.equal(resolveWorkspaceRole("x@example.com", null, admins), null);
  assert.equal(resolveWorkspaceRole("x@example.com", { role: "admin" }, admins), null);
  assert.equal(resolveWorkspaceRole("x@example.com", { role: ["staff"] }, admins), null);
  assert.equal(resolveWorkspaceRole(undefined, { role: "staff" }, parseAdminEmails("")), "staff");
});

test("empty admin list never promotes an empty email", () => {
  assert.equal(resolveWorkspaceRole("", {}, parseAdminEmails("")), null);
  assert.equal(resolveWorkspaceRole(null, {}, parseAdminEmails(",")), null);
});
