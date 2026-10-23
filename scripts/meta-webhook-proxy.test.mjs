import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { createWebhookOnlyProxy } from "./meta-webhook-proxy.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function send(port, { method = "GET", path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, method, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("webhook proxy forwards only exact GET and POST without changing body or signature", async () => {
  const received = [];
  const upstream = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      received.push({ method: incoming.method, url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks) });
      outgoing.writeHead(201, { "Content-Type": "text/plain", "X-Upstream-Test": "yes" });
      outgoing.end("received");
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createWebhookOnlyProxy({ upstreamPort });
  const proxyPort = await listen(proxy);

  try {
    const challenge = await send(proxyPort, {
      path: "/api/webhooks/meta/whatsapp?hub.mode=subscribe&hub.challenge=a%2Bb",
    });
    assert.equal(challenge.status, 201);
    assert.equal(challenge.headers["x-upstream-test"], "yes");
    assert.equal(received[0].url, "/api/webhooks/meta/whatsapp?hub.mode=subscribe&hub.challenge=a%2Bb");

    const body = Buffer.from([0, 255, 10, 123, 125]);
    const post = await send(proxyPort, {
      method: "POST",
      path: "/api/webhooks/meta/whatsapp?source=meta",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=test", "Content-Length": body.length },
      body,
    });
    assert.equal(post.status, 201);
    assert.equal(post.body.toString(), "received");
    assert.equal(received[1].url, "/api/webhooks/meta/whatsapp?source=meta");
    assert.equal(received[1].headers["x-hub-signature-256"], "sha256=test");
    assert.deepEqual(received[1].body, body);

    for (const path of ["/", "/dashboard", "/api/webhooks/meta/whatsapp/", "/api/webhooks/meta/%77hatsapp"]) {
      assert.equal((await send(proxyPort, { path })).status, 404);
    }
    assert.equal((await send(proxyPort, { method: "PUT", path: "/api/webhooks/meta/whatsapp" })).status, 404);
    assert.equal(received.length, 2);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
