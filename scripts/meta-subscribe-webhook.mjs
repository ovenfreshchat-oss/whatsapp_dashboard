import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const CALLBACK_PATH = "/api/webhooks/meta/whatsapp";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32_000;
const MAX_SUBSCRIPTION_PAGES = 10;

class OperatorError extends Error {}

function fail(message) {
  throw new OperatorError(message);
}

function requiredEnv(name, pattern) {
  const value = process.env[name]?.trim();
  if (!value || (pattern && !pattern.test(value))) {
    fail(`${name} is missing or invalid in the local environment.`);
  }
  return value;
}

function isPublicAddress(address, family) {
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only global unicast addresses are suitable for a public callback.
  const lower = address.toLowerCase();
  return family === 6 && /^[23][0-9a-f]*:/.test(lower) && !lower.startsWith("2001:db8:");
}

async function requirePublicCallback(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    fail("Pass a valid public HTTPS callback URL with --callback-url.");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.pathname !== CALLBACK_PATH ||
      url.search || url.hash || url.username || url.password || url.port ||
      !host.includes(".") || host.endsWith(".") ||
      host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".test") || host.endsWith(".invalid") ||
      host.endsWith(".example") || isIP(host.replace(/^\[|\]$/g, ""))) {
    fail(`Callback must be a public HTTPS URL ending in ${CALLBACK_PATH}, without a port, query, or fragment.`);
  }

  let addresses;
  let dnsTimeout;
  try {
    addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => {
        dnsTimeout = setTimeout(() => reject(new Error("DNS timeout")), REQUEST_TIMEOUT_MS);
        dnsTimeout.unref();
      }),
    ]);
  } catch {
    fail("Callback hostname could not be resolved to a public address.");
  } finally {
    clearTimeout(dnsTimeout);
  }
  if (addresses.length === 0 || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    fail("Callback hostname resolves to a private or reserved address.");
  }
  return url;
}

async function readBoundedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) fail("A remote endpoint returned no response body.");
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      fail("A remote endpoint returned an oversized response.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function readBoundedJson(response) {
  try {
    return JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES));
  } catch {
    fail("A remote endpoint returned invalid JSON.");
  }
}

async function verifyCallback(callback, verifyToken) {
  const challenge = randomBytes(24).toString("base64url");
  const url = new URL(callback);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", verifyToken);
  url.searchParams.set("hub.challenge", challenge);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail("The public callback could not be reached or redirected. No Meta subscription was changed.");
  }
  if (response.status !== 200 || Number(response.headers.get("content-length")) > 256) {
    fail(`The public callback did not complete verification (HTTP ${response.status}). No Meta subscription was changed.`);
  }
  const body = await readBoundedText(response, 256);
  if (body !== challenge) {
    fail("The public callback did not echo Meta's verification challenge. No Meta subscription was changed.");
  }
}

async function graphRequest(method, endpoint, accessToken, params) {
  const url = new URL(endpoint);
  if (params) url.search = params.toString();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail("Meta could not be reached. The subscription outcome is uncertain; inspect the WABA subscription list before retrying.");
  }
  const data = await readBoundedJson(response);
  if (!response.ok) {
    const code = Number.isInteger(data?.error?.code) ? `, code ${data.error.code}` : "";
    fail(`Meta rejected ${method} subscribed_apps (HTTP ${response.status}${code}).`);
  }
  return data;
}

async function isAppSubscribed(endpoint, accessToken, appId) {
  const seenCursors = new Set();
  let after;
  for (let page = 0; page < MAX_SUBSCRIPTION_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after", after);
    const result = await graphRequest("GET", endpoint, accessToken, params);
    if (!Array.isArray(result.data)) fail("Meta returned an invalid WABA subscription list.");
    if (result.data.some((item) => String(item?.whatsapp_business_api_data?.id ?? item?.id) === appId)) {
      return true;
    }
    if (!result.paging?.next) return false;
    after = result.paging?.cursors?.after;
    if (typeof after !== "string" || after.length > 4_000 || seenCursors.has(after)) {
      fail("Meta returned invalid WABA subscription pagination.");
    }
    seenCursors.add(after);
  }
  fail("Meta returned too many WABA subscription pages to verify safely.");
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--callback-url") {
    fail("Usage: npm run meta:subscribe-webhook -- --callback-url https://YOUR_DOMAIN/api/webhooks/meta/whatsapp");
  }
  const callback = await requirePublicCallback(process.argv[3]);
  if (process.env.WHATSAPP_SENDS_ENABLED?.trim().toLowerCase() === "true") {
    fail("Set WHATSAPP_SENDS_ENABLED=false before changing the webhook subscription.");
  }
  const version = requiredEnv("META_GRAPH_API_VERSION", /^v\d{1,3}\.\d{1,2}$/);
  const wabaId = requiredEnv("META_WABA_ID", /^\d{5,32}$/);
  const appId = requiredEnv("META_APP_ID", /^\d{5,32}$/);
  const accessToken = requiredEnv("META_SYSTEM_USER_ACCESS_TOKEN", /^\S+$/);
  const verifyToken = requiredEnv("META_WEBHOOK_VERIFY_TOKEN", /^\S+$/);

  await verifyCallback(callback, verifyToken);
  console.log("Public webhook verification passed.");

  const endpoint = `https://graph.facebook.com/${version}/${wabaId}/subscribed_apps`;
  let postFailure;
  try {
    const result = await graphRequest("POST", endpoint, accessToken);
    if (result.success !== true && result.success !== "true") {
      fail("Meta did not confirm the WABA subscription request.");
    }
  } catch (error) {
    postFailure = error;
  }

  try {
    if (await isAppSubscribed(endpoint, accessToken, appId)) {
      console.log("Configured Meta app is subscribed to the WABA. Refresh WhatsApp setup in the dashboard.");
      return;
    }
  } catch {
    fail("The WABA subscription could not be verified. Inspect it in Meta before retrying; no message was sent.");
  }
  if (postFailure) throw postFailure;
  fail("Meta accepted the request, but the configured META_APP_ID is absent from the WABA subscription list. Check that the token belongs to this app.");
}

main().catch((error) => {
  console.error(error instanceof OperatorError ? error.message : "Webhook subscription failed unexpectedly.");
  process.exitCode = 1;
});
