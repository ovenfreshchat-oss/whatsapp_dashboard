import { getWorkspaceAccess } from "@/server/auth/staff-users/admin";

const MAX_IMPORT_REQUEST_BYTES = 6 * 1024 * 1024;

export class ImportRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function importJson(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

export async function authorizeImportRequest(request: Request): Promise<void> {
  const origin = request.headers.get("origin");
  if (!origin) throw new ImportRequestError("Request origin is required.", 403);
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      throw new ImportRequestError("Request origin is not allowed.", 403);
    }
  } catch (error) {
    if (error instanceof ImportRequestError) throw error;
    throw new ImportRequestError("Request origin is invalid.", 403);
  }
  if (await getWorkspaceAccess() !== "allowed") {
    throw new ImportRequestError("Only a workspace admin can import contacts.", 403);
  }
}

export async function readImportForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new ImportRequestError("Upload a multipart form.", 415);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMPORT_REQUEST_BYTES) {
    throw new ImportRequestError("The upload exceeds 5 MiB.", 413);
  }
  if (!request.body) throw new ImportRequestError("Choose a file to upload.", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMPORT_REQUEST_BYTES) {
        await reader.cancel();
        throw new ImportRequestError("The upload exceeds 5 MiB.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(bytes.buffer, { headers: { "Content-Type": contentType } }).formData();
  } catch {
    throw new ImportRequestError("The upload form is invalid.", 400);
  }
}
