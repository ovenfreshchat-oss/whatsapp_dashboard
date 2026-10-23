import { previewContactImport } from "@/server/imports";
import { authorizeImportRequest, importJson, readImportForm } from "../shared";
import { importErrorResponse, importMapping, parsedImportFile } from "../input";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    await authorizeImportRequest(request);
    const form = await readImportForm(request);
    const parsed = await parsedImportFile(form);
    const mapping = importMapping(form);
    if (!mapping) {
      return importJson({
        fileName: parsed.fileName,
        fileKind: parsed.fileKind,
        fileSha256: parsed.fileSha256,
        sourceLabel: parsed.sourceLabel,
        sheetNames: parsed.sheetNames ?? [],
        headers: parsed.headers,
        totalRows: parsed.rows.length,
        sample: parsed.rows.slice(0, 5),
      });
    }
    const preview = previewContactImport(parsed, mapping);
    return importJson({
      fileName: preview.fileName,
      fileKind: preview.fileKind,
      fileSha256: preview.fileSha256,
      sourceLabel: preview.sourceLabel,
      headers: preview.headers,
      stats: preview.stats,
      rows: preview.rows.slice(0, 20),
      errors: preview.errors.slice(0, 100),
      remainingErrors: Math.max(0, preview.errors.length - 100),
    });
  } catch (error) {
    return importErrorResponse(error);
  }
}
