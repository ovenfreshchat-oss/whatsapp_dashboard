import {
  ContactImportError,
  MAX_CONTACT_FILE_BYTES,
  parseContactFile,
  type ContactColumnMapping,
} from "@/server/imports";
import { ImportRequestError } from "./shared";

function column(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Number.isInteger(value) && Number(value) >= 0 && Number(value) < 50) return Number(value);
  throw new ImportRequestError("Choose valid column positions.", 400);
}

export function importMapping(form: FormData): ContactColumnMapping | null {
  const raw = form.get("mapping");
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length > 4096) {
    throw new ImportRequestError("The column mapping is invalid.", 400);
  }
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    parsed = value as Record<string, unknown>;
  } catch {
    throw new ImportRequestError("The column mapping is invalid.", 400);
  }
  const phoneColumn = column(parsed.phoneColumn);
  if (phoneColumn === undefined) throw new ImportRequestError("Choose the phone number column.", 400);
  const defaultCountry = parsed.defaultCountry;
  if (defaultCountry !== undefined && defaultCountry !== "" &&
      (typeof defaultCountry !== "string" || !/^[A-Z]{2}$/.test(defaultCountry))) {
    throw new ImportRequestError("Choose a valid two-letter country code.", 400);
  }
  return {
    phoneColumn,
    nameColumn: column(parsed.nameColumn),
    consentColumn: column(parsed.consentColumn),
    evidenceColumn: column(parsed.evidenceColumn),
    consentOccurredAtColumn: column(parsed.consentOccurredAtColumn),
    defaultCountry: typeof defaultCountry === "string" && defaultCountry ? defaultCountry : undefined,
  };
}

export async function parsedImportFile(form: FormData) {
  const upload = form.get("file");
  if (!(upload instanceof File) || !upload.name || upload.size === 0) {
    throw new ImportRequestError("Choose a CSV, Excel, or Word file.", 400);
  }
  if (upload.size > MAX_CONTACT_FILE_BYTES) {
    throw new ImportRequestError("The file exceeds 5 MiB.", 413);
  }
  const sheetName = form.get("sheetName");
  if (sheetName !== null && (typeof sheetName !== "string" || sheetName.length > 120)) {
    throw new ImportRequestError("The sheet name is invalid.", 400);
  }
  return parseContactFile({
    fileName: upload.name,
    bytes: new Uint8Array(await upload.arrayBuffer()),
    sheetName: typeof sheetName === "string" && sheetName ? sheetName : undefined,
  });
}

export function importErrorResponse(error: unknown): Response {
  if (error instanceof ImportRequestError) {
    return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof ContactImportError) {
    return Response.json({ error: error.message, code: error.code }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "The import could not be processed." }, { status: 500, headers: { "Cache-Control": "no-store" } });
}
