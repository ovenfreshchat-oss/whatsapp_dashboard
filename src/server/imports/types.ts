export const MAX_CONTACT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CONTACT_IMPORT_ROWS = 5_000;

export type ContactFileKind = "csv" | "xlsx" | "docx";

export type ParsedContactFile = {
  fileName: string;
  fileKind: ContactFileKind;
  fileSha256: string;
  sourceLabel: string;
  /** Visible workbook tab names; present for .xlsx files only. */
  sheetNames?: string[];
  headers: string[];
  rows: Array<{ rowNumber: number; cells: string[] }>;
};

export class ContactImportError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported_file" | "file_size" | "invalid_file" | "row_limit" | "invalid_mapping",
  ) {
    super(message);
    this.name = "ContactImportError";
  }
}
