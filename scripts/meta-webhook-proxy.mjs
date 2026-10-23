import { createServer, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEBHOOK_PATH = "/api/webhooks/meta/whatsapp";
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 3002;
const UPSTREAM_PORT = 3001;

export function createWebhookOnlyProxy({ upstreamPort = UPSTREAM_PORT } = {}) {
  return createServer((incoming, outgoing) => {
    const target = incoming.url ?? "";
    const queryIndex = target.indexOf("?");
    const path = queryIndex < 0 ? target : target.slice(0, queryIndex);

    if (path !== WEBHOOK_PATH || (incoming.method !== "GET" && incoming.method !== "POST")) {
      incoming.resume();
      outgoing.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      outgoing.end("Not found");
      return;
    }

    const upstream = httpRequest({
      hostname: LISTEN_HOST,
      port: upstreamPort,
      method: incoming.method,
      path: target,
      headers: { ...incoming.headers, host: `${LISTEN_HOST}:${upstreamPort}` },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });

    upstream.on("error", () => {
      if (outgoing.headersSent) {
        outgoing.destroy();
      } else {
        outgoing.writeHead(502, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
        outgoing.end("Webhook app unavailable");
      }
    });
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWebhookOnlyProxy().listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`Webhook-only proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  });
}
