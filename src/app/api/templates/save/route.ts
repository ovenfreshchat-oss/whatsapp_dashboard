import { revalidatePath } from "next/cache";
import { getStaffAdminAccess } from "@/server/auth/staff-users/admin";
import { getMetaConfigurationStatus } from "@/server/meta/client";
import {
  MAX_HEADER_IMAGE_BYTES,
  saveMetaTemplate,
  TemplateInputError,
  type TemplateSaveInput,
} from "@/server/meta/template-manage";

export const runtime = "nodejs";

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  try {
    if (!origin || new URL(origin).origin !== new URL(request.url).origin) return json({ error: "Request origin is not allowed." }, 403);
  } catch {
    return json({ error: "Request origin is invalid." }, 403);
  }
  if (await getStaffAdminAccess() !== "allowed") return json({ error: "Only a workspace admin can manage templates." }, 403);
  if (!getMetaConfigurationStatus().configured) return json({ error: "Complete the Meta configuration first." }, 503);

  let form: FormData;
  try { form = await request.formData(); } catch { return json({ error: "Could not read the form." }, 400); }

  let examples: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text(form, "examples") || "[]");
    if (Array.isArray(parsed)) examples = parsed.map((v) => String(v));
  } catch { return json({ error: "Could not read the sample values." }, 400); }

  const file = form.get("image");
  let image: TemplateSaveInput["image"];
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_HEADER_IMAGE_BYTES) return json({ error: "The image must be under 5 MB." }, 413);
    image = { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, name: file.name || "header" };
  }

  try {
    const result = await saveMetaTemplate({
      templateId: text(form, "templateId") || undefined,
      name: text(form, "name").trim(),
      language: text(form, "language").trim(),
      category: text(form, "category") as TemplateSaveInput["category"],
      body: text(form, "body"),
      footer: text(form, "footer"),
      format: text(form, "format") === "named" ? "named" : "positional",
      examples,
      image,
    });
    revalidatePath("/dashboard/templates");
    return json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof TemplateInputError) return json({ error: error.message }, 400);
    console.error("Template save failed");
    return json({ error: "Meta could not be reached. Try again." }, 502);
  }
}
