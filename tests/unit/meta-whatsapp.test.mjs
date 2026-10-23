import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  MetaWebhookPayloadError,
  MetaWebhookSizeError,
  MetaWebhookSourceError,
  classifyInboundOptOut,
  parseMetaWhatsAppPayload,
  readBoundedBody,
  verifyMetaSignature,
  verifyMetaToken,
} from "../../src/server/webhooks/meta-whatsapp.ts";

const expected = { wabaId: "waba-1", phoneNumberId: "phone-1" };
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));

function fixture() {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-1" },
              messages: [
                { id: "message-stop", from: "15551234567", timestamp: "1792100000", type: "text", text: { body: "STOP!" } },
                { id: "message-question", from: "15550000000", type: "text", text: { body: "Please stop messaging me" } },
              ],
              statuses: [
                { id: "wamid-1", status: "sent", recipient_id: "15551234567", timestamp: "1792100001" },
                { id: "wamid-1", status: "delivered", recipient_id: "15551234567", timestamp: "1792100002" },
              ],
            },
          },
          { field: "message_template_status_update", value: { event: "APPROVED" } },
        ],
      },
    ],
  };
}

test("verification compares a subscription token and signs the exact raw bytes", () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account", "entry":[]}');
  const signature = `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;
  assert.equal(verifyMetaToken("verify-me", "verify-me"), true);
  assert.equal(verifyMetaToken("verify-me-wrong", "verify-me"), false);
  assert.equal(verifyMetaSignature(raw, signature, "app-secret"), true);
  assert.equal(verifyMetaSignature(Buffer.from('{"object":"whatsapp_business_account","entry":[]}'), signature, "app-secret"), false);
  assert.equal(verifyMetaSignature(raw, "sha256=malformed", "app-secret"), false);
});

test("parses every nested inbound message, status, and other change", () => {
  const parsed = parseMetaWhatsAppPayload(encode(fixture()), expected);
  assert.equal(parsed.items.length, 5);
  assert.deepEqual(parsed.items.map((item) => item.kind), ["message", "message", "status", "status", "change"]);
  assert.deepEqual(parsed.items.filter((item) => item.kind === "status").map((item) => item.provider_status), ["sent", "delivered"]);
  assert.equal(parsed.items[0].event_timestamp, "2026-10-15T21:33:20.000Z");
  assert.equal(parsed.opt_outs.length, 2);
  assert.equal(parsed.opt_outs[0].identity_value, "15551234567");
  assert.equal(parsed.opt_outs[0].source_item_key, parsed.items[0].dedupe_key);
  assert.equal(parsed.opt_outs[0].hold_only, false);
  assert.equal(parsed.opt_outs[1].hold_only, true);
  assert.equal(parsed.items[1].needs_review, true);
  assert.equal(parsed.items[4].needs_review, true);
});

test("dedupes inbound IDs and canonical status payloads across replays", () => {
  const first = fixture();
  const second = fixture();
  second.entry[0].changes[0].value.messages[0].text.body = "STOP";
  const a = parseMetaWhatsAppPayload(encode(first), expected);
  const b = parseMetaWhatsAppPayload(encode(second), expected);
  assert.equal(a.items[0].dedupe_key, b.items[0].dedupe_key);
  assert.equal(a.items[2].dedupe_key, b.items[2].dedupe_key);
  assert.notEqual(a.payload_sha256, b.payload_sha256);
});

test("keeps deleted and unsupported statuses in the inbox for review", () => {
  const payload = fixture();
  payload.entry[0].changes[0].value.statuses = [
    { id: "wamid-1", status: "deleted", recipient_id: "15551234567", timestamp: "1792100001" },
    { id: "wamid-2", status: "unknown_future_status", recipient_id: "15551234567", timestamp: "1792100002" },
    { id: "wamid-3", status: "delivered", recipient_id: "15551234567", timestamp: "1792100003" },
  ];
  const statuses = parseMetaWhatsAppPayload(encode(payload), expected).items.filter((item) => item.kind === "status");
  assert.deepEqual(statuses.map((item) => item.needs_review), [true, true, false]);
  assert.deepEqual(statuses.map((item) => item.provider_status), ["deleted", "unknown_future_status", "delivered"]);
});

test("recognizes clear button opt-outs and flags ambiguous text", () => {
  assert.equal(classifyInboundOptOut({ type: "button", button: { payload: "OPT_OUT" } }), "clear");
  assert.equal(classifyInboundOptOut({ interactive: { button_reply: { id: "custom-stop" } } }, new Set(["custom-stop"])), "clear");
  assert.equal(classifyInboundOptOut({ text: { body: "Please stop texting me" } }), "review");
  assert.equal(classifyInboundOptOut({ text: { body: "Stop by tomorrow" } }), "none");
  assert.equal(classifyInboundOptOut({ text: { body: "Hello" } }), "none");
});

test("rejects malformed events and unexpected sender scope", () => {
  const wrongWaba = fixture();
  wrongWaba.entry[0].id = "other-waba";
  assert.throws(() => parseMetaWhatsAppPayload(encode(wrongWaba), expected), MetaWebhookSourceError);
  const wrongPhone = fixture();
  wrongPhone.entry[0].changes[0].value.metadata.phone_number_id = "other-phone";
  assert.throws(() => parseMetaWhatsAppPayload(encode(wrongPhone), expected), MetaWebhookSourceError);
  assert.throws(() => parseMetaWhatsAppPayload(Buffer.from("not-json"), expected), MetaWebhookPayloadError);
});

test("bounds streaming reads even without a Content-Length header", async () => {
  const request = new Request("https://example.test/webhook", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.close();
      },
    }),
    duplex: "half",
  });
  await assert.rejects(readBoundedBody(request, 4), MetaWebhookSizeError);
});
