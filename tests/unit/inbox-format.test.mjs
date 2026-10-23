import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLY_WINDOW_MS,
  conversationTitle,
  formatPhone,
  formatTime,
  isUuid,
  replyErrorMessage,
  replyWindow,
  safeTimeZone,
  statusLabel,
} from "../../src/server/inbox/format.ts";

const now = new Date("2026-10-20T12:00:00Z");
const ago = (ms) => new Date(now.valueOf() - ms).toISOString();

test("reply window is open just inside 24 hours and closed at the boundary", () => {
  const inside = replyWindow(ago(REPLY_WINDOW_MS - 60_000), now);
  assert.equal(inside.open, true);
  assert.equal(inside.remainingLabel, "1m");
  assert.equal(replyWindow(ago(REPLY_WINDOW_MS), now).open, false);
  assert.equal(replyWindow(ago(REPLY_WINDOW_MS + 1), now).open, false);
});

test("reply window label formats hours and minutes", () => {
  const window = replyWindow(ago(60 * 60_000), now); // 23h left
  assert.equal(window.open, true);
  assert.equal(window.remainingLabel, "23h 0m");
  assert.equal(replyWindow(ago(REPLY_WINDOW_MS - 90 * 60_000), now).remainingLabel, "1h 30m");
});

test("customers who never wrote, or with a bad timestamp, have a closed window", () => {
  assert.deepEqual(replyWindow(null, now), { open: false, closesAt: null, remainingLabel: null });
  assert.equal(replyWindow("not a date", now).open, false);
});

test("a future inbound timestamp (clock skew) never exceeds 24 hours", () => {
  const window = replyWindow(new Date(now.valueOf() + 5 * 60_000).toISOString(), now);
  assert.equal(window.open, true);
  assert.match(window.remainingLabel, /^24h/);
});

test("phone and title fallbacks", () => {
  assert.equal(formatPhone("15551234567"), "+15551234567");
  assert.equal(formatPhone("bsuid.abc"), "bsuid.abc");
  assert.equal(conversationTitle("  Asha  ", "15551234567"), "Asha");
  assert.equal(conversationTitle(null, "15551234567"), "+15551234567");
  assert.equal(conversationTitle("   ", "15551234567"), "+15551234567");
});

test("time zone handling falls back to UTC and formats in the requested zone", () => {
  assert.equal(safeTimeZone(undefined), "UTC");
  assert.equal(safeTimeZone("Not/AZone"), "UTC");
  assert.equal(safeTimeZone("Asia/Kolkata"), "Asia/Kolkata");
  assert.match(formatTime("2026-10-20T12:00:00Z", "Asia/Kolkata", { withDate: false }), /17:30/);
  assert.equal(formatTime(null, "UTC"), "—");
  assert.equal(formatTime("garbage", "UTC"), "—");
});

test("status labels and reply errors never leak raw database messages", () => {
  assert.equal(statusLabel("read"), "Read");
  assert.equal(statusLabel("uncertain"), "Outcome uncertain");
  assert.equal(statusLabel("received"), "");
  for (const code of ["window_closed", "opted_out", "sender_hold", "invalid_reply", "invalid_recipient", "conversation_missing", "anything else"]) {
    assert.ok(replyErrorMessage(code).length > 10);
    assert.ok(!replyErrorMessage(code).includes("_"));
  }
});

test("uuid validation rejects non-UUIDs, including injection attempts", () => {
  assert.equal(isUuid("aaaaaaaa-0000-4000-8000-000000000001"), true);
  assert.equal(isUuid("aaaaaaaa-0000-4000-8000-00000000000"), false);
  assert.equal(isUuid("x' or 1=1 --"), false);
  assert.equal(isUuid(undefined), false);
});
