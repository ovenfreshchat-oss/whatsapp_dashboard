import { normalizeContactPhone } from "./phone";
import { ContactImportError, type ParsedContactFile } from "./types";

export type ContactColumnMapping = {
  phoneColumn: number | string;
  nameColumn?: number | string;
  consentColumn?: number | string;
  evidenceColumn?: number | string;
  consentOccurredAtColumn?: number | string;
  /** ISO 3166-1 alpha-2 country, only when staff deliberately selects it. */
  defaultCountry?: string;
};

export type ContactImportRowError = {
  row_number: number;
  code: string;
  message: string;
};

export type ContactImportValidRow = {
  row_number: number;
  phone_e164: string;
  display_name: string | null;
  consent_claimed: boolean;
  consent_explicit_no: boolean;
  evidence_reference: string | null;
  consent_occurred_at: string | null;
  consent_occurred_on: string | null;
};

export type ContactImportPreviewRow = {
  rowNumber: number;
  rawPhone: string;
  phoneE164: string | null;
  displayName: string | null;
  consentClaimed: boolean;
  consentExplicitNo: boolean;
  evidenceReference: string | null;
  consentOccurredAt: string | null;
  consentOccurredOn: string | null;
  errors: string[];
  warnings: string[];
};

export type ContactImportPreview = {
  fileName: string;
  fileKind: ParsedContactFile["fileKind"];
  fileSha256: string;
  sourceLabel: string;
  sheetNames?: string[];
  headers: string[];
  rows: ContactImportPreviewRow[];
  validRows: ContactImportValidRow[];
  errors: ContactImportRowError[];
  stats: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    pendingConsentClaims: number;
    negativeConsentRows: number;
    claimsMissingEvidence: number;
    claimsMissingTimestamp: number;
    dateOnlyConsentClaims: number;
    claimsAwaitingDateReview: number;
  };
};

function resolveColumn(headers: string[], selected: number | string | undefined, required: boolean): number | null {
  if (selected === undefined || selected === "") {
    if (!required) return null;
    throw new ContactImportError("Select the phone number column.", "invalid_mapping");
  }
  if (typeof selected === "number") {
    if (Number.isInteger(selected) && selected >= 0 && selected < headers.length) return selected;
  } else {
    const matches = headers.flatMap((label, index) =>
      label.trim().toLowerCase() === selected.trim().toLowerCase() ? [index] : []);
    if (matches.length === 1) return matches[0];
  }
  throw new ContactImportError("A selected column is missing or ambiguous.", "invalid_mapping");
}

function consentClaim(value: string): "yes" | "no" | "empty" | "unknown" {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!normalized) return "empty";
  if (["no", "false", "0", "n", "not opted in", "opted out", "unsubscribed", "declined", "stop"].includes(normalized)) return "no";
  if (["yes", "true", "1", "y", "opted in", "consented"].includes(normalized)) return "yes";
  return "unknown";
}

/** Exact timestamps require a timezone; date-only evidence is handled separately. */
function consentTimestamp(value: string): string | null {
  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i,
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > days ||
      hour > 23 || minute > 59 || second > 59) return null;
  if (match[7].toUpperCase() !== "Z") {
    const offsetHours = Number(match[7].slice(1, 3));
    const offsetMinutes = Number(match[7].slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds > Date.now() + 5 * 60_000) return null;
  return new Date(milliseconds).toISOString();
}

function consentDate(value: string): { occurredAt: string; occurredOn: string; awaitingReview: boolean } | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const occurredOn = `${match[1]}-${match[2]}-${match[3]}`;
  if (occurredOn > new Date().toISOString().slice(0, 10)) return null;
  const midnightUtc = Date.UTC(year, month - 1, day);
  // UTC+14 is the earliest possible start of a calendar date anywhere.
  const occurredAt = new Date(midnightUtc - 14 * 60 * 60_000).toISOString();
  // UTC-12 is the latest possible end. No date-only grant is reviewed earlier.
  const latestEndUtc = midnightUtc + 36 * 60 * 60_000;
  return { occurredAt, occurredOn, awaitingReview: Date.now() < latestEndUtc };
}

/** Preview never verifies consent; a consent-column yes becomes a pending claim. */
export function previewContactImport(
  parsed: ParsedContactFile,
  mapping: ContactColumnMapping,
): ContactImportPreview {
  const phoneColumn = resolveColumn(parsed.headers, mapping.phoneColumn, true)!;
  const nameColumn = resolveColumn(parsed.headers, mapping.nameColumn, false);
  const consentColumn = resolveColumn(parsed.headers, mapping.consentColumn, false);
  const evidenceColumn = resolveColumn(parsed.headers, mapping.evidenceColumn, false);
  const occurredColumn = resolveColumn(parsed.headers, mapping.consentOccurredAtColumn, false);
  const chosen = [phoneColumn, nameColumn, consentColumn, evidenceColumn, occurredColumn].filter((n) => n !== null);
  if (new Set(chosen).size !== chosen.length) {
    throw new ContactImportError("Map each field to a different column.", "invalid_mapping");
  }

  const rows: ContactImportPreviewRow[] = [];
  const validRows: ContactImportValidRow[] = [];
  const errors: ContactImportRowError[] = [];
  // If a file repeats a phone with both Yes and No, import the explicit No.
  // Otherwise a later opt-out could be rejected as a duplicate while a grant survives.
  const preferredRows = new Map<string, { rowNumber: number; explicitNo: boolean }>();
  for (const row of parsed.rows) {
    const phone = normalizeContactPhone(row.cells[phoneColumn] ?? "", mapping.defaultCountry);
    if (!phone.ok) continue;
    const explicitNo = consentColumn !== null && consentClaim(row.cells[consentColumn] ?? "") === "no";
    const preferred = preferredRows.get(phone.e164);
    if (!preferred || (explicitNo && !preferred.explicitNo)) {
      preferredRows.set(phone.e164, { rowNumber: row.rowNumber, explicitNo });
    }
  }
  let duplicateRows = 0;
  let pendingConsentClaims = 0;
  let negativeConsentRows = 0;
  let claimsMissingEvidence = 0;
  let claimsMissingTimestamp = 0;
  let dateOnlyConsentClaims = 0;
  let claimsAwaitingDateReview = 0;

  for (const row of parsed.rows) {
    const rawPhone = row.cells[phoneColumn] ?? "";
    const rawName = nameColumn === null ? "" : (row.cells[nameColumn] ?? "").trim();
    const claim = consentColumn === null ? "empty" : consentClaim(row.cells[consentColumn] ?? "");
    const rawEvidence = evidenceColumn === null ? "" : (row.cells[evidenceColumn] ?? "").trim();
    const rawOccurred = occurredColumn === null ? "" : (row.cells[occurredColumn] ?? "").trim();
    const phone = normalizeContactPhone(rawPhone, mapping.defaultCountry);
    const rowErrors: string[] = [];
    const warnings: string[] = [];
    if (!phone.ok) {
      rowErrors.push(phone.message);
      errors.push({ row_number: row.rowNumber, code: phone.code, message: phone.message });
    }
    if (rawName.length > 160 && claim !== "no") {
      rowErrors.push("Name is longer than 160 characters.");
      errors.push({ row_number: row.rowNumber, code: "name_too_long", message: "Name is longer than 160 characters." });
    } else if (rawName.length > 160) {
      warnings.push("Name is longer than 160 characters and will be omitted; the opt-out will still be applied.");
    }
    if (phone.ok) {
      const chosen = preferredRows.get(phone.e164)!;
      if (chosen.rowNumber !== row.rowNumber) {
        const message = `Duplicate phone number; row ${chosen.rowNumber} is used${chosen.explicitNo ? " for the opt-out" : ""}.`;
        rowErrors.push(message);
        errors.push({ row_number: row.rowNumber, code: "duplicate_in_file", message });
        duplicateRows += 1;
      }
    }

    if (claim === "unknown") warnings.push("Consent value is unrecognized; no consent claim will be imported.");
    const consentClaimed = claim === "yes";
    const consentExplicitNo = claim === "no";
    if (consentExplicitNo) warnings.push("Explicit No will suppress WhatsApp marketing for this phone when imported.");
    let evidenceReference: string | null = null;
    let consentOccurredAt: string | null = null;
    let consentOccurredOn: string | null = null;
    let missingEvidence = false;
    let missingTimestamp = false;
    let awaitingDateReview = false;
    if (consentClaimed) {
      warnings.push("Imported consent is pending admin evidence review.");
      if (rawEvidence && rawEvidence.length <= 500) evidenceReference = rawEvidence;
      else {
        warnings.push(rawEvidence ? "Evidence reference is longer than 500 characters." : "Evidence reference is missing.");
        missingEvidence = true;
      }
      const dateOnly = consentDate(rawOccurred);
      if (dateOnly) {
        consentOccurredAt = dateOnly.occurredAt;
        consentOccurredOn = dateOnly.occurredOn;
        awaitingDateReview = dateOnly.awaitingReview;
        warnings.push("Consent date is date-only; its time and timezone are unknown.");
        if (awaitingDateReview) warnings.push("Date-only consent can be reviewed after the date has ended worldwide.");
      } else {
        consentOccurredAt = consentTimestamp(rawOccurred);
      }
      if (!consentOccurredAt) {
        warnings.push("Consent needs a valid YYYY-MM-DD date or ISO 8601 timestamp with a timezone; future dates cannot be imported as consent evidence.");
        missingTimestamp = true;
      }
    }

    const preview: ContactImportPreviewRow = {
      rowNumber: row.rowNumber,
      rawPhone,
      phoneE164: phone.ok ? phone.e164 : null,
      displayName: rawName.length > 160 ? null : rawName || null,
      consentClaimed,
      consentExplicitNo,
      evidenceReference,
      consentOccurredAt,
      consentOccurredOn,
      errors: rowErrors,
      warnings,
    };
    rows.push(preview);
    if (rowErrors.length === 0 && phone.ok) {
      validRows.push({
        row_number: row.rowNumber,
        phone_e164: phone.e164,
        display_name: rawName.length > 160 ? null : rawName || null,
        consent_claimed: consentClaimed,
        consent_explicit_no: consentExplicitNo,
        evidence_reference: evidenceReference,
        consent_occurred_at: consentOccurredAt,
        consent_occurred_on: consentOccurredOn,
      });
      if (consentClaimed) {
        pendingConsentClaims += 1;
        if (missingEvidence) claimsMissingEvidence += 1;
        if (missingTimestamp) claimsMissingTimestamp += 1;
        if (consentOccurredOn) dateOnlyConsentClaims += 1;
        if (awaitingDateReview) claimsAwaitingDateReview += 1;
      }
      if (consentExplicitNo) negativeConsentRows += 1;
    }
  }

  return {
    fileName: parsed.fileName,
    fileKind: parsed.fileKind,
    fileSha256: parsed.fileSha256,
    sourceLabel: parsed.sourceLabel,
    ...(parsed.sheetNames ? { sheetNames: parsed.sheetNames } : {}),
    headers: parsed.headers,
    rows,
    validRows,
    errors,
    stats: {
      totalRows: rows.length,
      validRows: validRows.length,
      invalidRows: rows.length - validRows.length,
      duplicateRows,
      pendingConsentClaims,
      negativeConsentRows,
      claimsMissingEvidence,
      claimsMissingTimestamp,
      dateOnlyConsentClaims,
      claimsAwaitingDateReview,
    },
  };
}
