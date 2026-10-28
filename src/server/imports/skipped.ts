import type { ContactImportPreview } from "./preview";

export type SkippedRow = {
  rowNumber: number;
  name: string | null;
  /** The number as written in the file, or the cleaned number when it could be read. */
  phone: string;
  /** Every reason this row was skipped, in plain language. */
  reasons: string[];
  codes: string[];
};

/** Short labels for the summary chips above the skipped list. */
export const SKIP_REASON_LABELS: Record<string, string> = {
  missing_phone: "Empty phone number",
  country_code_required: "Missing country code",
  invalid_phone: "Not a valid number",
  name_too_long: "Name too long",
  duplicate_in_file: "Duplicate in file",
};

/**
 * Every row that will not be imported, with every reason. The preview screen, the import result
 * and the tests all use this one function, so the "skipped" count and the list can never disagree.
 */
export function listSkippedRows(preview: Pick<ContactImportPreview, "rows" | "errors">): SkippedRow[] {
  const codesByRow = new Map<number, string[]>();
  for (const error of preview.errors) {
    const list = codesByRow.get(error.row_number) ?? [];
    if (!list.includes(error.code)) list.push(error.code);
    codesByRow.set(error.row_number, list);
  }
  return preview.rows
    .filter((row) => row.errors.length > 0)
    .map((row) => ({
      rowNumber: row.rowNumber,
      name: row.displayName,
      phone: row.phoneE164 ?? row.rawPhone,
      reasons: row.errors,
      codes: codesByRow.get(row.rowNumber) ?? [],
    }));
}

export function countSkipReasons(skipped: SkippedRow[]): { code: string; label: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const row of skipped) {
    // A row with two problems is counted once, under its first reason.
    const code = row.codes[0] ?? "other";
    totals.set(code, (totals.get(code) ?? 0) + 1);
  }
  return [...totals.entries()]
    .map(([code, count]) => ({ code, label: SKIP_REASON_LABELS[code] ?? "Other problem", count }))
    .sort((a, b) => b.count - a.count);
}
