import {
  getConfiguredMetaIdentifiers,
  getMetaAccountHealth,
  MetaApiError,
  metaGraphCollection,
  metaGraphPost,
} from "./client";

export type MetaTemplateButton = {
  type: string | null;
  text: string | null;
  url: string | null;
  phoneNumber: string | null;
};

export type MetaTemplateComponent = {
  type: string;
  format: string | null;
  text: string | null;
  buttons: MetaTemplateButton[];
};

export type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: MetaTemplateComponent[];
};

export type MetaTemplateSync = {
  wabaId: string;
  syncedAt: string;
  templates: MetaTemplate[];
};

export type TemplateBodyParameterSpec = {
  format: "positional" | "named";
  /** Positional indexes are sorted; named keys follow their first appearance in the body. */
  keys: string[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new MetaApiError(`Meta returned a template without ${label}.`, "response");
  return result;
}

function normalizeTemplate(value: unknown): MetaTemplate {
  const item = record(value);
  if (!item || !Array.isArray(item.components)) {
    throw new MetaApiError("Meta returned an invalid template.", "response");
  }

  const components = item.components.map((value): MetaTemplateComponent => {
    const component = record(value);
    if (!component) throw new MetaApiError("Meta returned an invalid template component.", "response");
    if (component.buttons !== undefined && !Array.isArray(component.buttons)) {
      throw new MetaApiError("Meta returned invalid template buttons.", "response");
    }
    const buttons: unknown[] = Array.isArray(component.buttons) ? component.buttons : [];
    return {
      type: requiredString(component.type, "component type").toUpperCase(),
      format: optionalString(component.format),
      text: optionalString(component.text),
      buttons: buttons.map((value) => {
        const button = record(value);
        if (!button) throw new MetaApiError("Meta returned an invalid template button.", "response");
        return {
          type: optionalString(button.type),
          text: optionalString(button.text),
          url: optionalString(button.url),
          phoneNumber: optionalString(button.phone_number),
        };
      }),
    };
  });

  return {
    id: requiredString(item.id, "an ID"),
    name: requiredString(item.name, "a name"),
    language: requiredString(item.language, "a language"),
    category: requiredString(item.category, "a category").toUpperCase(),
    status: requiredString(item.status, "a status").toUpperCase(),
    components,
  };
}

/** Fetches a complete fresh WABA snapshot. Persistence belongs to the calling service. */
export async function syncMetaTemplates(): Promise<MetaTemplateSync> {
  const { wabaId } = getConfiguredMetaIdentifiers();
  const fields = "id,name,language,category,status,components";
  const data = await metaGraphCollection(
    `${wabaId}/message_templates`,
    new URLSearchParams({ fields }),
  );
  const templates = data.map(normalizeTemplate);
  return { wabaId, syncedAt: new Date().toISOString(), templates };
}

export type ApprovedTemplateTestSend = {
  /** A single, opted-in test recipient. Authorization and consent checks belong to the caller. */
  recipientE164: string;
  templateName: string;
  languageCode: string;
  /** Campaigns pin the template identity captured at review. */
  expectedTemplateId?: string;
  /** Campaigns reject edits to any stored component, including static content. */
  expectedTemplateSnapshot?: unknown;
  /** Values follow the text body's positional indexes or named keys. */
  bodyParameters?: string[];
  /** Image header URL for templates with an IMAGE header. */
  headerMediaUrl?: string;
  /** Recheck the current sender hold and recipient opt-out immediately before POST. */
  beforeSend?: () => Promise<void>;
};

export type MetaAcceptedTestSend = {
  messageId: string;
  recipientE164: string;
  acceptedAt: string;
};

function reject(message: string): never {
  throw new MetaApiError(message, "validation", { definitiveRejection: true });
}

function validateTestSend(input: ApprovedTemplateTestSend): string[] {
  if (!/^\+[1-9]\d{7,14}$/.test(input.recipientE164)) {
    reject("The test recipient must have a valid E.164 phone number.");
  }
  if (!/^[a-z0-9_]{1,512}$/.test(input.templateName)) {
    reject("The template name is invalid.");
  }
  if (!/^[A-Za-z]{2,8}(?:_[A-Za-z0-9]{2,8})?$/.test(input.languageCode)) {
    reject("The template language code is invalid.");
  }
  if (input.expectedTemplateId !== undefined &&
      !/^\d{5,32}$/.test(input.expectedTemplateId)) {
    reject("The expected template ID is invalid.");
  }
  if (input.bodyParameters !== undefined && !Array.isArray(input.bodyParameters)) {
    reject("Template body parameters must be an array.");
  }
  if (input.beforeSend !== undefined && typeof input.beforeSend !== "function") {
    reject("The final send check is invalid.");
  }
  if (input.headerMediaUrl !== undefined) {
    if (typeof input.headerMediaUrl !== "string" || !/^https:\/\/[^\s$.?#].[^\s]*$/i.test(input.headerMediaUrl.trim())) {
      reject("The header image URL must be a valid https:// URL.");
    }
  }
  const parameters = input.bodyParameters ?? [];
  if (parameters.length > 20) reject("Too many template body parameters were provided.");
  for (const parameter of parameters) {
    if (typeof parameter !== "string" || !parameter.trim() || parameter.length > 1024) {
      reject("A template body parameter is invalid.");
    }
  }
  return parameters;
}

export type ApprovedTemplateValidation = TemplateBodyParameterSpec & {
  headerFormat: "IMAGE" | "TEXT" | null;
};

export function parseTemplateBodyParameters(body: string): TemplateBodyParameterSpec {
  const placeholder = /\{\{([^{}]*)\}\}/g;
  const rawKeys = [...body.matchAll(placeholder)].map((match) => match[1].trim());
  const residual = body.replace(placeholder, "");
  if (residual.includes("{{") || residual.includes("}}")) {
    reject("This template uses unsupported body placeholders.");
  }
  if (rawKeys.length === 0) return { format: "positional", keys: [] };

  if (rawKeys.every((key) => /^[1-9]\d*$/.test(key))) {
    const keys = [...new Set(rawKeys)].sort((left, right) => Number(left) - Number(right));
    if (keys.some((value, index) => Number(value) !== index + 1)) {
      reject("The template body has nonsequential placeholders.");
    }
    return { format: "positional", keys };
  }
  if (rawKeys.every((key) => /^[a-z][a-z_]{0,19}$/.test(key))) {
    return { format: "named", keys: [...new Set(rawKeys)] };
  }
  reject("This template uses unsupported body placeholders.");
}

export function assertApprovedMarketingTemplate(
  template: MetaTemplate,
  parameters: string[],
  headerMediaUrl?: string,
): ApprovedTemplateValidation {
  if (template.status !== "APPROVED" || template.category !== "MARKETING") {
    reject("The selected marketing template is not currently approved.");
  }

  const supported = new Set(["HEADER", "BODY", "FOOTER", "BUTTONS"]);
  if (template.components.some((part) => !supported.has(part.type))) {
    reject("This template type is not supported for test sends.");
  }
  const header = template.components.find((part) => part.type === "HEADER");
  const headerFormat = (header?.format ? header.format.toUpperCase() : null) as "IMAGE" | "TEXT" | null;
  if (header && headerFormat && headerFormat !== "TEXT" && headerFormat !== "IMAGE") {
    reject("A media-header template needs a separate tested parameter mapper.");
  }
  if (headerFormat === "TEXT" && header?.text?.includes("{{")) {
    reject("Variable headers are not supported for test sends.");
  }
  if (headerFormat === "IMAGE" && headerMediaUrl !== undefined) {
    if (!headerMediaUrl || !/^https:\/\/[^\s$.?#].[^\s]*$/i.test(headerMediaUrl.trim())) {
      reject("Templates with an image header require a valid https:// image URL.");
    }
  }
  const buttons = template.components.find((part) => part.type === "BUTTONS");
  const supportedButtonTypes = new Set(["URL", "PHONE_NUMBER", "QUICK_REPLY"]);
  if (buttons?.buttons.some((button) =>
    !button.type || !supportedButtonTypes.has(button.type.toUpperCase()) ||
    !button.text ||
    (button.type.toUpperCase() === "URL" && !button.url) ||
    (button.type.toUpperCase() === "PHONE_NUMBER" && !button.phoneNumber))) {
    reject("This template has a button type that needs a separate reviewed sender.");
  }
  if (buttons?.buttons.some((button) => [button.text, button.url].some((value) => value?.includes("{{")))) {
    reject("Variable buttons are not supported for test sends.");
  }

  const body = template.components.find((part) => part.type === "BODY");
  if (!body?.text) reject("The selected template has no supported text body.");
  const spec = parseTemplateBodyParameters(body.text);
  if (spec.keys.length > 20 || parameters.length !== spec.keys.length) {
    reject("The supplied values do not match the template body placeholders.");
  }
  return { ...spec, headerFormat };
}

function canonicalSnapshot(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshot).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, part]) =>
      `${JSON.stringify(key)}:${canonicalSnapshot(part)}`).join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean") return JSON.stringify(value);
  reject("The reviewed template snapshot is invalid.");
}

/** Compare the whole normalized template, not only its Graph ID. */
export function assertTemplateSnapshotUnchanged(
  live: MetaTemplate,
  expected: unknown,
): void {
  if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      canonicalSnapshot(live) !== canonicalSnapshot(expected)) {
    reject("The approved template content changed since campaign review.");
  }
}

/**
 * Sends exactly one approved marketing template to a caller-verified test recipient.
 * A returned wamid means acceptance only; delivery is established by later webhooks.
 * The caller must record an in-flight attempt before invoking this method and must not
 * blindly retry when a thrown MetaApiError has definitiveRejection === false.
 */
export async function sendApprovedTemplateTest(
  input: ApprovedTemplateTestSend,
): Promise<MetaAcceptedTestSend> {
  const parameters = validateTestSend(input);
  const { phoneNumberId } = getConfiguredMetaIdentifiers();
  let parameterSpec: TemplateBodyParameterSpec = { format: "positional", keys: [] };

  // Every failure before the POST is definitive: no message request was made.
  try {
    const [health, snapshot] = await Promise.all([getMetaAccountHealth(), syncMetaTemplates()]);
    if (!health.phoneBelongsToWaba) reject("The configured sender is not in the WABA.");
    const template = snapshot.templates.find(
      (item) => item.name === input.templateName && item.language === input.languageCode,
    );
    if (!template) reject("The selected template is no longer available in this language.");
    if (input.expectedTemplateId && template.id !== input.expectedTemplateId) {
      reject("The approved template changed since campaign review.");
    }
    const validation = assertApprovedMarketingTemplate(template, parameters, input.headerMediaUrl);
    parameterSpec = validation;
    if (validation.headerFormat === "IMAGE" && !input.headerMediaUrl?.trim()) {
      reject("An image header URL is required for this template.");
    }
    if (input.expectedTemplateSnapshot !== undefined) {
      assertTemplateSnapshotUnchanged(template, input.expectedTemplateSnapshot);
    }
  } catch (error) {
    if (error instanceof MetaApiError) {
      throw new MetaApiError(error.message, error.category, {
        definitiveRejection: true,
        httpStatus: error.httpStatus,
        providerCode: error.providerCode,
        providerSubcode: error.providerSubcode,
      });
    }
    throw new MetaApiError("The final eligibility check did not pass.", "validation", {
      definitiveRejection: true,
    });
  }

  const templateComponents: Record<string, unknown>[] = [];
  if (input.headerMediaUrl?.trim()) {
    templateComponents.push({
      type: "header",
      parameters: [{
        type: "image",
        image: { link: input.headerMediaUrl.trim() },
      }],
    });
  }
  if (parameters.length) {
    templateComponents.push({
      type: "body",
      parameters: parameters.map((text, index) => ({
        type: "text",
        ...(parameterSpec.format === "named" ? { parameter_name: parameterSpec.keys[index] } : {}),
        text,
      })),
    });
  }

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.recipientE164.slice(1),
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      ...(templateComponents.length ? { components: templateComponents } : {}),
    },
  };
  if (input.beforeSend) {
    try {
      await input.beforeSend();
    } catch {
      reject("The final eligibility check did not pass.");
    }
  }
  const response = await metaGraphPost(`${phoneNumberId}/messages`, body);
  const messages = response.messages;
  const messageId = Array.isArray(messages) ? optionalString(record(messages[0])?.id) : null;
  if (!messageId || !messageId.startsWith("wamid.")) {
    throw new MetaApiError("Meta accepted the request without a usable message ID; reconcile before retrying.", "response");
  }
  return { messageId, recipientE164: input.recipientE164, acceptedAt: new Date().toISOString() };
}

/** The same guarded single-recipient operation is used by controlled campaigns. */
export const sendApprovedMarketingTemplate = sendApprovedTemplateTest;
