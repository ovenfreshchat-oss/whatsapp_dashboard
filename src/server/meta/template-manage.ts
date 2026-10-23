import { getConfiguredMetaIdentifiers } from "./client";

const GRAPH = "https://graph.facebook.com";
export const MAX_HEADER_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png"];

export class TemplateInputError extends Error {}

export type TemplateSaveInput = {
  /** Present when editing an existing template (name and language cannot change). */
  templateId?: string;
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  body: string;
  footer: string;
  /** "named" keeps variables like {{customer_name}}; new templates use numbered ones. */
  format?: "positional" | "named";
  /** One sample value per variable, in order of first appearance. */
  examples: string[];
  image?: { bytes: Uint8Array; mime: string; name: string };
};

export type TemplateSaveResult = { id: string; status: string | null };

function settings() {
  const token = process.env.META_SYSTEM_USER_ACCESS_TOKEN?.trim();
  const version = process.env.META_GRAPH_API_VERSION?.trim();
  const { wabaId, appId } = getConfiguredMetaIdentifiers();
  if (!token || !version) throw new TemplateInputError("Meta is not configured.");
  return { token, version, wabaId, appId };
}

/** Variable keys in order of first appearance; throws a plain message when they are not usable. */
export function templateVariables(body: string, format: "positional" | "named" = "positional"): string[] {
  const found = [...body.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1].trim());
  if (format === "named") {
    if (found.some((k) => !/^[a-z][a-z_]{0,19}$/.test(k))) {
      throw new TemplateInputError("Variable names: lowercase letters and underscores only, like {{customer_name}}.");
    }
    return [...new Set(found)];
  }
  if (found.some((k) => !/^[1-9]\d*$/.test(k))) throw new TemplateInputError("Use variables like {{1}}, {{2}} only.");
  const unique = [...new Set(found.map(Number))].sort((a, b) => a - b);
  if (unique.some((n, i) => n !== i + 1)) throw new TemplateInputError("Variables must go in order: {{1}}, {{2}}, {{3}}.");
  return unique.map(String);
}

function validate(input: TemplateSaveInput): string[] {
  if (!input.templateId) {
    if (!/^[a-z0-9_]{1,100}$/.test(input.name)) throw new TemplateInputError("Name: use lowercase letters, numbers and underscores only.");
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(input.language)) throw new TemplateInputError("Choose a language.");
  } else if (!/^\d{5,32}$/.test(input.templateId)) {
    throw new TemplateInputError("Template not found.");
  }
  if (input.category !== "MARKETING" && input.category !== "UTILITY") throw new TemplateInputError("Choose a category.");
  const body = input.body.trim();
  if (!body) throw new TemplateInputError("Write the message text.");
  if (body.length > 1024) throw new TemplateInputError("The message can be at most 1024 characters.");
  const keys = templateVariables(body, input.format);
  const count = keys.length;
  if (/^\s*\{\{/.test(body) || /\}\}\s*$/.test(body)) {
    throw new TemplateInputError("WhatsApp does not allow a variable at the very start or end of the message. Add some text around it.");
  }
  if (input.examples.length !== count || input.examples.some((e) => !e.trim() || e.length > 200)) {
    throw new TemplateInputError("Enter a sample value for every variable.");
  }
  if (input.footer.length > 60) throw new TemplateInputError("The footer can be at most 60 characters.");
  if (/\{\{/.test(input.footer)) throw new TemplateInputError("The footer cannot have variables.");
  if (input.image) {
    if (!IMAGE_TYPES.includes(input.image.mime)) throw new TemplateInputError("The image must be a JPG or PNG.");
    if (input.image.bytes.byteLength === 0 || input.image.bytes.byteLength > MAX_HEADER_IMAGE_BYTES) {
      throw new TemplateInputError("The image must be under 5 MB.");
    }
  }
  return keys;
}

async function graphError(response: Response): Promise<string> {
  let message = `Meta rejected the request (HTTP ${response.status}).`;
  try {
    const json = await response.json() as { error?: { message?: string; error_user_title?: string; error_user_msg?: string } };
    const e = json.error;
    if (e) message = [e.error_user_title, e.error_user_msg ?? e.message].filter(Boolean).join(": ").slice(0, 300) || message;
  } catch { /* keep the generic message */ }
  return message;
}

/** Meta's resumable upload gives the example handle a template image header needs. */
async function uploadHeaderImage(image: NonNullable<TemplateSaveInput["image"]>): Promise<string> {
  const { token, version, appId } = settings();
  if (!appId) throw new TemplateInputError("META_APP_ID is needed to upload an image.");
  const start = await fetch(
    `${GRAPH}/${version}/${appId}/uploads?${new URLSearchParams({
      file_length: String(image.bytes.byteLength), file_type: image.mime, file_name: image.name.slice(0, 100),
    })}`,
    { method: "POST", headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(20_000) },
  );
  if (!start.ok) throw new TemplateInputError(await graphError(start));
  const session = (await start.json() as { id?: string }).id;
  if (!session) throw new TemplateInputError("Meta did not start the image upload.");
  const upload = await fetch(`${GRAPH}/${version}/${session}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_offset: "0" },
    body: Buffer.from(image.bytes),
    signal: AbortSignal.timeout(60_000),
  });
  if (!upload.ok) throw new TemplateInputError(await graphError(upload));
  const handle = (await upload.json() as { h?: string }).h;
  if (!handle) throw new TemplateInputError("Meta did not accept the image.");
  return handle;
}

export async function saveMetaTemplate(input: TemplateSaveInput): Promise<TemplateSaveResult> {
  const keys = validate(input);
  const count = keys.length;
  const named = input.format === "named";
  const { token, version, wabaId } = settings();
  const components: Record<string, unknown>[] = [];
  if (input.image) {
    const handle = await uploadHeaderImage(input.image);
    components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } });
  }
  components.push({
    type: "BODY",
    text: input.body.trim(),
    ...(count === 0 ? {} : named
      ? { example: { body_text_named_params: keys.map((key, i) => ({ param_name: key, example: input.examples[i].trim() })) } }
      : { example: { body_text: [input.examples.map((e) => e.trim())] } }),
  });
  if (input.footer.trim()) components.push({ type: "FOOTER", text: input.footer.trim() });

  const editing = Boolean(input.templateId);
  const response = await fetch(
    `${GRAPH}/${version}/${editing ? input.templateId : `${wabaId}/message_templates`}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(editing
        ? { components }
        : { name: input.name, language: input.language, category: input.category, components,
            ...(named ? { parameter_format: "NAMED" } : {}) }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new TemplateInputError(await graphError(response));
  const json = await response.json() as { id?: string; status?: string; success?: boolean };
  return { id: json.id ?? input.templateId ?? "", status: json.status ?? (json.success ? "PENDING" : null) };
}
