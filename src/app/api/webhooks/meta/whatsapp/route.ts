import { createClient } from "@supabase/supabase-js";
import {
  MetaWebhookPayloadError,
  MetaWebhookSizeError,
  MetaWebhookSourceError,
  parseMetaWhatsAppPayload,
  readBoundedBody,
  verifyMetaSignature,
  verifyMetaToken,
} from "@/server/webhooks/meta-whatsapp";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

function configured() {
  const appSecret = process.env.META_APP_SECRET;
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  const wabaId = process.env.META_WABA_ID;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
  if (!appSecret || !verifyToken || !wabaId || !phoneNumberId || !supabaseUrl || !supabaseSecret) {
    return null;
  }
  return { appSecret, verifyToken, wabaId, phoneNumberId, supabaseUrl, supabaseSecret };
}

export async function GET(request: Request): Promise<Response> {
  const settings = configured();
  if (!settings) return new Response("Webhook unavailable", { status: 503, headers: noStore });

  const params = new URL(request.url).searchParams;
  const challenge = params.get("hub.challenge");
  if (params.get("hub.mode") !== "subscribe" || !challenge || challenge.length > 256 ||
      !verifyMetaToken(params.get("hub.verify_token"), settings.verifyToken)) {
    return new Response("Forbidden", { status: 403, headers: noStore });
  }
  return new Response(challenge, {
    status: 200,
    headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const settings = configured();
  if (!settings) return new Response("Webhook unavailable", { status: 503, headers: noStore });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return new Response("Unsupported media type", { status: 415, headers: noStore });
  }

  let body: Uint8Array;
  try {
    body = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof MetaWebhookSizeError) {
      return new Response("Payload too large", { status: 413, headers: noStore });
    }
    return new Response("Unable to read webhook", { status: 400, headers: noStore });
  }
  if (!verifyMetaSignature(body, request.headers.get("x-hub-signature-256"), settings.appSecret)) {
    return new Response("Forbidden", { status: 403, headers: noStore });
  }

  let webhook;
  try {
    const buttonPayloads = new Set(
      (process.env.META_OPT_OUT_BUTTON_PAYLOADS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    );
    webhook = parseMetaWhatsAppPayload(body, {
      wabaId: settings.wabaId,
      phoneNumberId: settings.phoneNumberId,
      buttonPayloads,
    });
  } catch (error) {
    if (error instanceof MetaWebhookSourceError) {
      return new Response("Forbidden", { status: 403, headers: noStore });
    }
    if (error instanceof MetaWebhookPayloadError) {
      return new Response("Invalid webhook", { status: 400, headers: noStore });
    }
    return new Response("Unable to parse webhook", { status: 400, headers: noStore });
  }

  const supabase = createClient(settings.supabaseUrl, settings.supabaseSecret, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  try {
    const { error } = await supabase.rpc("receive_meta_whatsapp_webhook", {
      p_payload_sha256: webhook.payload_sha256,
      p_payload: webhook.payload,
      p_items: webhook.items,
      p_opt_outs: webhook.opt_outs,
    });
    if (error) {
      console.error("Meta webhook receipt failed", { code: error.code });
      return new Response("Webhook receipt unavailable", { status: 503, headers: noStore });
    }
  } catch {
    console.error("Meta webhook receipt failed", { code: "network" });
    return new Response("Webhook receipt unavailable", { status: 503, headers: noStore });
  }

  return new Response("EVENT_RECEIVED", { status: 200, headers: noStore });
}
