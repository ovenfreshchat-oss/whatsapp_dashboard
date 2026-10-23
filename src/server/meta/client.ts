/** Server-side access to the configured WhatsApp Business Account. */

const GRAPH_ORIGIN = "https://graph.facebook.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 4_000_000;
const MAX_COLLECTION_PAGES = 40;

type MetaErrorCategory =
  | "configuration"
  | "validation"
  | "provider"
  | "transport"
  | "response";

/** Safe to display: this error never contains Meta's raw response or the bearer token. */
export class MetaApiError extends Error {
  readonly category: MetaErrorCategory;
  readonly definitiveRejection: boolean;
  readonly httpStatus?: number;
  readonly providerCode?: number;
  readonly providerSubcode?: number;

  constructor(
    message: string,
    category: MetaErrorCategory,
    options: {
      definitiveRejection?: boolean;
      httpStatus?: number;
      providerCode?: number;
      providerSubcode?: number;
    } = {},
  ) {
    super(message);
    this.name = "MetaApiError";
    this.category = category;
    this.definitiveRejection =
      options.definitiveRejection ?? (category === "configuration" || category === "validation");
    this.httpStatus = options.httpStatus;
    this.providerCode = options.providerCode;
    this.providerSubcode = options.providerSubcode;
  }
}

export type MetaConfigurationStatus = {
  configured: boolean;
  missing: string[];
  invalid: string[];
};

type MetaConfiguration = {
  accessToken: string;
  wabaId: string;
  phoneNumberId: string;
  graphApiVersion: string;
  appId: string | null;
};

const REQUIRED_ENV = [
  "META_SYSTEM_USER_ACCESS_TOKEN",
  "META_WABA_ID",
  "META_PHONE_NUMBER_ID",
  "META_GRAPH_API_VERSION",
] as const;

const graphIdPattern = /^\d{5,32}$/;
const graphVersionPattern = /^v\d{1,3}\.\d{1,2}$/;

export function getMetaConfigurationStatus(): MetaConfigurationStatus {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  const invalid: string[] = [];

  for (const name of ["META_WABA_ID", "META_PHONE_NUMBER_ID", "META_APP_ID"]) {
    const value = process.env[name]?.trim();
    if (value && !graphIdPattern.test(value)) invalid.push(name);
  }

  const version = process.env.META_GRAPH_API_VERSION?.trim();
  if (version && !graphVersionPattern.test(version)) {
    invalid.push("META_GRAPH_API_VERSION");
  }

  const token = process.env.META_SYSTEM_USER_ACCESS_TOKEN?.trim();
  if (token && /\s/.test(token)) invalid.push("META_SYSTEM_USER_ACCESS_TOKEN");

  return { configured: missing.length === 0 && invalid.length === 0, missing, invalid };
}

function readMetaConfiguration(): MetaConfiguration {
  const status = getMetaConfigurationStatus();
  if (!status.configured) {
    const names = [...status.missing, ...status.invalid].join(", ");
    throw new MetaApiError(`Meta configuration is incomplete or invalid: ${names}.`, "configuration");
  }

  return {
    accessToken: process.env.META_SYSTEM_USER_ACCESS_TOKEN!.trim(),
    wabaId: process.env.META_WABA_ID!.trim(),
    phoneNumberId: process.env.META_PHONE_NUMBER_ID!.trim(),
    graphApiVersion: process.env.META_GRAPH_API_VERSION!.trim(),
    appId: process.env.META_APP_ID?.trim() || null,
  };
}

export function getConfiguredMetaIdentifiers(): {
  wabaId: string;
  phoneNumberId: string;
  appId: string | null;
} {
  const { wabaId, phoneNumberId, appId } = readMetaConfiguration();
  return { wabaId, phoneNumberId, appId };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

async function requestGraph(
  method: "GET" | "POST",
  path: string,
  query?: URLSearchParams,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const config = readMetaConfiguration();
  const url = new URL(`${config.graphApiVersion}/${path}`, `${GRAPH_ORIGIN}/`);
  if (query) url.search = query.toString();

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.accessToken}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // A send may have reached Meta before a timeout. The caller must reconcile it.
    throw new MetaApiError("Meta could not be reached; the request outcome is uncertain.", "transport");
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new MetaApiError("Meta's response could not be read.", "response");
  }

  if (raw.length > MAX_RESPONSE_CHARS) {
    throw new MetaApiError("Meta returned an unexpectedly large response.", "response");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = record(record(payload)?.error);
    const providerCode = numberOrUndefined(error?.code);
    const providerSubcode = numberOrUndefined(error?.error_subcode);
    const codeNote = providerCode === undefined ? "" : ` (code ${providerCode})`;
    // A response from an intermediary or a transient provider failure does not
    // prove that a POST had no side effect. Park those sends for reconciliation.
    const ambiguousPost = method === "POST" && (
      response.status >= 500 || [408, 409, 425, 429].includes(response.status)
    );
    throw new MetaApiError(
      `${ambiguousPost ? "Meta returned an uncertain response" : "Meta rejected the request"} with HTTP ${response.status}${codeNote}.`,
      "provider",
      { definitiveRejection: !ambiguousPost, httpStatus: response.status, providerCode, providerSubcode },
    );
  }

  const result = record(payload);
  if (!result) throw new MetaApiError("Meta returned an invalid response.", "response");
  return result;
}

/** Use only for fixed Graph paths built from validated configuration IDs. */
export function metaGraphGet(path: string, query?: URLSearchParams) {
  return requestGraph("GET", path, query);
}

/** A successful HTTP response still only means Meta accepted a message for processing. */
export function metaGraphPost(path: string, body: unknown) {
  return requestGraph("POST", path, undefined, body);
}

export async function metaGraphCollection(
  path: string,
  query: URLSearchParams = new URLSearchParams(),
): Promise<unknown[]> {
  const all: unknown[] = [];
  const params = new URLSearchParams(query);
  params.set("limit", "100");
  const seenCursors = new Set<string>();

  for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
    const payload = await metaGraphGet(path, params);
    if (!Array.isArray(payload.data)) {
      throw new MetaApiError("Meta returned an invalid collection.", "response");
    }
    all.push(...payload.data);

    const paging = record(payload.paging);
    if (!paging?.next) return all;
    const after = optionalString(record(paging.cursors)?.after);
    if (!after || after.length > 4_000 || seenCursors.has(after)) {
      throw new MetaApiError("Meta returned invalid pagination data.", "response");
    }
    seenCursors.add(after);
    params.set("after", after);
  }

  // Never report a partial sync as complete.
  throw new MetaApiError("Meta returned too many pages to sync safely.", "response");
}

export type MetaPhoneNumber = {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  nameStatus: string | null;
};

export type MetaAccountHealth = {
  wabaId: string;
  wabaName: string | null;
  phoneNumberId: string;
  phoneNumber: MetaPhoneNumber | null;
  phoneBelongsToWaba: boolean;
  checkedAt: string;
};

export async function getMetaAccountHealth(): Promise<MetaAccountHealth> {
  const { wabaId, phoneNumberId } = getConfiguredMetaIdentifiers();
  const [waba, phones] = await Promise.all([
    metaGraphGet(wabaId, new URLSearchParams({ fields: "id,name" })),
    metaGraphCollection(`${wabaId}/phone_numbers`),
  ]);
  if (waba.id !== wabaId) {
    throw new MetaApiError("Meta returned a different business account.", "response");
  }

  const matching = phones.map(record).find((phone) => phone?.id === phoneNumberId);
  const phoneNumber = matching
    ? {
        id: phoneNumberId,
        displayPhoneNumber: optionalString(matching.display_phone_number),
        verifiedName: optionalString(matching.verified_name),
        qualityRating: optionalString(matching.quality_rating),
        nameStatus: optionalString(matching.name_status),
      }
    : null;

  return {
    wabaId,
    wabaName: optionalString(waba.name),
    phoneNumberId,
    phoneNumber,
    phoneBelongsToWaba: phoneNumber !== null,
    checkedAt: new Date().toISOString(),
  };
}

export type MetaWebhookSubscription = { id: string; name: string | null };

export type MetaWebhookSubscriptionStatus = {
  subscriptions: MetaWebhookSubscription[];
  /** Null means META_APP_ID was not configured, so this app cannot be identified. */
  isCurrentAppSubscribed: boolean | null;
  checkedAt: string;
};

export async function listMetaWebhookSubscriptions(): Promise<MetaWebhookSubscriptionStatus> {
  const { wabaId, appId } = getConfiguredMetaIdentifiers();
  const items = await metaGraphCollection(`${wabaId}/subscribed_apps`);
  const subscriptions = items.map((item) => {
    const wrapper = record(item);
    const app = record(wrapper?.whatsapp_business_api_data) ?? wrapper;
    const id = optionalString(app?.id);
    if (!id) throw new MetaApiError("Meta returned an invalid app subscription.", "response");
    return { id, name: optionalString(app?.name) };
  });

  return {
    subscriptions,
    isCurrentAppSubscribed: appId ? subscriptions.some((item) => item.id === appId) : null,
    checkedAt: new Date().toISOString(),
  };
}
