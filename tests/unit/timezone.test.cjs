const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../../src/lib/timezone.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
new Function("module", "exports", "process", outputText)(mod, mod.exports, process);
const tz = mod.exports;
const TORONTO = "America/Toronto";

test("winter shows EST (UTC-5) and summer shows EDT (UTC-4) without any fixed offset", () => {
  assert.equal(tz.formatDateTime("2026-01-15T14:00:00Z", TORONTO), "2026-01-15 09:00 EST");
  assert.equal(tz.formatDateTime("2026-07-15T13:00:00Z", TORONTO), "2026-07-15 09:00 EDT");
  assert.equal(tz.zoneOffsetMinutes(Date.parse("2026-01-15T14:00:00Z"), TORONTO), -300);
  assert.equal(tz.zoneOffsetMinutes(Date.parse("2026-07-15T13:00:00Z"), TORONTO), -240);
});

test("the day can differ from UTC: late evening in Toronto is already tomorrow in UTC", () => {
  assert.equal(tz.formatDate("2026-11-05T02:30:00Z", TORONTO), "2026-11-04");
  assert.equal(tz.formatDateTime("2026-11-05T02:30:00Z", TORONTO), "2026-11-04 21:30 EST");
});

test("the two 2026 clock changes land on the right Sunday", () => {
  // Spring: 2026-03-08 at 07:00 UTC the clocks jump from 02:00 EST to 03:00 EDT.
  assert.equal(tz.formatDateTime("2026-03-08T06:59:00Z", TORONTO), "2026-03-08 01:59 EST");
  assert.equal(tz.formatDateTime("2026-03-08T07:00:00Z", TORONTO), "2026-03-08 03:00 EDT");
  // Autumn: 2026-11-01 at 06:00 UTC the clocks go back from 02:00 EDT to 01:00 EST.
  assert.equal(tz.formatDateTime("2026-11-01T05:59:00Z", TORONTO), "2026-11-01 01:59 EDT");
  assert.equal(tz.formatDateTime("2026-11-01T06:00:00Z", TORONTO), "2026-11-01 01:00 EST");
});

test("a time typed in Toronto becomes the right UTC instant in EST and EDT", () => {
  assert.deepEqual(tz.zonedLocalToUtc("2026-12-10T09:00", TORONTO), { ok: true, iso: "2026-12-10T14:00:00.000Z", ambiguous: false });
  assert.deepEqual(tz.zonedLocalToUtc("2026-07-10T09:00", TORONTO), { ok: true, iso: "2026-07-10T13:00:00.000Z", ambiguous: false });
  assert.deepEqual(tz.zonedLocalToUtc("2026-11-10T09:00", TORONTO), { ok: true, iso: "2026-11-10T14:00:00.000Z", ambiguous: false });
});

test("round trip: UTC to Toronto input and back gives the same instant all year", () => {
  for (let day = 0; day < 365; day += 1) {
    const instant = new Date(Date.UTC(2026, 0, 1, 15, 0) + day * 86_400_000).toISOString();
    const local = tz.utcToLocalInput(instant, TORONTO);
    const back = tz.zonedLocalToUtc(local, TORONTO);
    assert.equal(back.ok, true, local);
    assert.equal(back.iso, new Date(instant).toISOString(), local);
  }
});

test("a time that does not exist is refused and a time that happens twice uses the first", () => {
  assert.deepEqual(tz.zonedLocalToUtc("2026-03-08T02:30", TORONTO), { ok: false, reason: "gap" });
  assert.deepEqual(tz.zonedLocalToUtc("2026-11-01T01:30", TORONTO), { ok: true, iso: "2026-11-01T05:30:00.000Z", ambiguous: true });
  assert.deepEqual(tz.zonedLocalToUtc("2026-02-30T10:00", TORONTO), { ok: false, reason: "invalid" });
  assert.deepEqual(tz.zonedLocalToUtc("tomorrow", TORONTO), { ok: false, reason: "invalid" });
});

test("changing the zone setting changes the result without any other change", () => {
  assert.equal(tz.formatDateTime("2026-07-15T13:00:00Z", "Asia/Kolkata"), "2026-07-15 18:30 GMT+5:30");
  assert.equal(tz.formatDateTime("2026-07-15T13:00:00Z", "America/Vancouver"), "2026-07-15 06:00 PDT");
  assert.equal(tz.zonedLocalToUtc("2026-07-15T09:00", "America/Vancouver").iso, "2026-07-15T16:00:00.000Z");
});

test("the configured zone is read from CLIENT_TIME_ZONE and falls back safely", () => {
  const saved = { c: process.env.CLIENT_TIME_ZONE, l: process.env.WHATSAPP_SEND_TIME_ZONE };
  try {
    delete process.env.CLIENT_TIME_ZONE; delete process.env.WHATSAPP_SEND_TIME_ZONE;
    assert.equal(tz.getClientTimeZone(), "America/Toronto");
    assert.equal(tz.getSendTimeZone(), "America/Toronto");
    process.env.CLIENT_TIME_ZONE = "America/Vancouver";
    assert.equal(tz.getClientTimeZone(), "America/Vancouver");
    process.env.CLIENT_TIME_ZONE = "Not/AZone";
    assert.equal(tz.getClientTimeZone(), "America/Toronto");
    delete process.env.CLIENT_TIME_ZONE;
    process.env.WHATSAPP_SEND_TIME_ZONE = "UTC";
    assert.equal(tz.getSendTimeZone(), "UTC");
    assert.equal(tz.getClientTimeZone(), "America/Toronto");
  } finally {
    if (saved.c === undefined) delete process.env.CLIENT_TIME_ZONE; else process.env.CLIENT_TIME_ZONE = saved.c;
    if (saved.l === undefined) delete process.env.WHATSAPP_SEND_TIME_ZONE; else process.env.WHATSAPP_SEND_TIME_ZONE = saved.l;
  }
});

test("presets and day starts follow the Toronto calendar", () => {
  const now = Date.parse("2026-11-04T03:00:00Z"); // 22:00 on Nov 3 in Toronto
  assert.equal(tz.todayInZone(TORONTO, now), "2026-11-03");
  assert.equal(tz.nextLocalHour(18, TORONTO, false, now), "2026-11-04T18:00");
  assert.equal(tz.nextLocalHour(10, TORONTO, true, now), "2026-11-04T10:00");
  assert.equal(tz.startOfDayUtc("2026-11-03", TORONTO), "2026-11-03T05:00:00.000Z"); // after the Nov 1 change: EST
  assert.equal(tz.startOfDayUtc("2026-10-30", TORONTO), "2026-10-30T04:00:00.000Z"); // before it: EDT
});
