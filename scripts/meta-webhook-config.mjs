// Read-only: shows where Meta sends webhooks for this WABA and phone number.
// Run: node --env-file=.env scripts/meta-webhook-config.mjs
const version = process.env.META_GRAPH_API_VERSION?.trim();
const wabaId = process.env.META_WABA_ID?.trim();
const phoneId = process.env.META_PHONE_NUMBER_ID?.trim();
const token = process.env.META_SYSTEM_USER_ACCESS_TOKEN?.trim();
if (!version || !wabaId || !phoneId || !token) {
  console.error("META_GRAPH_API_VERSION, META_WABA_ID, META_PHONE_NUMBER_ID and META_SYSTEM_USER_ACCESS_TOKEN must be set.");
  process.exit(1);
}
async function get(path) {
  const response = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { error: body?.error?.message ?? `HTTP ${response.status}` };
}
const waba = await get(`${wabaId}/subscribed_apps`);
const phone = await get(`${phoneId}?fields=webhook_configuration,display_phone_number,quality_rating,messaging_limit_tier,throughput`);
console.log("WABA subscribed apps (override_callback_uri is where WABA webhooks go):");
console.log(JSON.stringify(waba, null, 2));
console.log("\nPhone number (webhook_configuration.override_callback_uri beats the WABA setting):");
console.log(JSON.stringify(phone, null, 2));
