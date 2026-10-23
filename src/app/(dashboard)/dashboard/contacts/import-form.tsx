"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./contacts.module.css";

type RawPreview = {
  fileName: string;
  fileKind: string;
  fileSha256: string;
  sourceLabel: string;
  sheetNames: string[];
  headers: string[];
  totalRows: number;
  sample: { rowNumber: number; cells: string[] }[];
};

type MappedPreview = {
  fileSha256: string;
  stats: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    pendingConsentClaims: number;
    claimsMissingEvidence: number;
    claimsMissingTimestamp: number;
    dateOnlyConsentClaims: number;
    claimsAwaitingDateReview: number;
    negativeConsentRows: number;
  };
  rows: {
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
  }[];
  errors: { row_number: number; code: string; message: string }[];
  remainingErrors: number;
};

type Mapping = {
  phoneColumn: number | null;
  nameColumn: number | null;
  consentColumn: number | null;
  evidenceColumn: number | null;
  consentOccurredAtColumn: number | null;
  defaultCountry: string;
};

const emptyMapping: Mapping = {
  phoneColumn: null,
  nameColumn: null,
  consentColumn: null,
  evidenceColumn: null,
  consentOccurredAtColumn: null,
  defaultCountry: "",
};

function firstColumn(headers: string[], expression: RegExp): number | null {
  const index = headers.findIndex((heading) => expression.test(heading.trim()));
  return index < 0 ? null : index;
}

// Only the phone number is imported. Name, consent, and country columns are never read.
function suggestedMapping(headers: string[]): Mapping {
  const matchedPhone = firstColumn(headers, /^(phone|phone number|mobile|mobile number|whatsapp|whatsapp number|number|to)$/i);
  // A one-column file can only be the phone numbers, whatever its header says.
  const phone = matchedPhone ?? (headers.length === 1 ? 0 : null);
  return { ...emptyMapping, phoneColumn: phone };
}

function makeForm(file: File, mapping?: Mapping, hash?: string, importKey?: string, sheetName?: string): FormData {
  const form = new FormData();
  form.set("file", file);
  if (mapping) {
    form.set("mapping", JSON.stringify({
      phoneColumn: mapping.phoneColumn,
      nameColumn: mapping.nameColumn,
      consentColumn: mapping.consentColumn,
      evidenceColumn: mapping.evidenceColumn,
      consentOccurredAtColumn: mapping.consentOccurredAtColumn,
      defaultCountry: mapping.defaultCountry.trim().toUpperCase(),
    }));
  }
  if (hash) form.set("expectedFileSha256", hash);
  if (importKey) form.set("importKey", importKey);
  if (sheetName) form.set("sheetName", sheetName);
  return form;
}

async function postImport(path: string, body: FormData): Promise<unknown> {
  const response = await fetch(path, { method: "POST", body, credentials: "same-origin" });
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("The import service returned an invalid response.");
  const object = value as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof object.error === "string" ? object.error : "The import failed.");
  return value;
}

export function ContactImportForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [raw, setRaw] = useState<RawPreview | null>(null);
  const [mapped, setMapped] = useState<MappedPreview | null>(null);
  const [mapping, setMapping] = useState<Mapping>(emptyMapping);
  const [importKey, setImportKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [resultBatchId, setResultBatchId] = useState("");

  async function inspect(selectedSheet = sheetName) {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult("");
    setResultBatchId("");
    try {
      const value = await postImport("/api/contacts/import/preview", makeForm(file, undefined, undefined, undefined, selectedSheet)) as RawPreview;
      setRaw(value);
      setSheetName(value.fileKind === "xlsx" ? value.sourceLabel : "");
      setMapping(suggestedMapping(value.headers));
      setMapped(null);
      setImportKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not inspect the file.");
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    if (!file || !raw || mapping.phoneColumn === null) return;
    setBusy(true);
    setError("");
    setResult("");
    setResultBatchId("");
    try {
      const value = await postImport("/api/contacts/import/preview", makeForm(file, mapping, undefined, undefined, sheetName)) as MappedPreview;
      if (value.fileSha256 !== raw.fileSha256) throw new Error("The file changed. Inspect it again.");
      setMapped(value);
      setImportKey(crypto.randomUUID());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview the contacts.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!file || !raw || !mapped || !importKey) return;
    setBusy(true);
    setError("");
    try {
      const form = makeForm(file, mapping, raw.fileSha256, importKey, sheetName);
      const value = await postImport("/api/contacts/import/commit", form) as {
        result: { batch_id: string; inserted: number; existing: number; consent_claims: number; negative_consent_rows: number; rejected_rows: number };
        linked?: number | null;
        linkError?: string | null;
      };
      const parts = [`Imported ${value.result.inserted} new contacts; ${value.result.existing} already existed; ${value.result.rejected_rows} rows were skipped.`];
      if (value.linkError) parts.push(value.linkError);
      setResult(parts.join(" "));
      setResultBatchId(value.result.consent_claims > 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.result.batch_id) ? value.result.batch_id : "");
      setMapped(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import the contacts.");
    } finally {
      setBusy(false);
    }
  }

  function selectField(label: string, key: keyof Omit<Mapping, "defaultCountry">) {
    return (
      <label className={styles.field} key={key}>
        <span>{label}</span>
        <select value={mapping[key] ?? ""} onChange={(event) => {
          setMapping({ ...mapping, [key]: event.target.value === "" ? null : Number(event.target.value) });
          setMapped(null);
        }}>
          <option value="">{key === "phoneColumn" ? "Select a column" : "None"}</option>
          {raw?.headers.map((heading, index) => <option key={index} value={index}>{heading || `Column ${index + 1}`}</option>)}
        </select>
      </label>
    );
  }

  return (
    <div className={styles.stack}>
      <p className={styles.muted}>Upload a CSV, Excel (.xlsx), or Word (.docx) table up to 5 MiB and 5,000 rows. Download a Google Sheet as .xlsx or .csv first. The first row must contain column headers.</p>
      <Link className={styles.contactLink} href="/templates/whatsapp-contacts-template.docx" download>Download Word contact template (.docx) →</Link>
      <div className={styles.fileRow}>
        <label className={styles.field}><span>Contact file</span><input type="file" accept=".csv,.xlsx,.docx" onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          setSheetName("");
          setRaw(null);
          setMapped(null);
          setMapping(emptyMapping);
          setResult("");
          setResultBatchId("");
          setError("");
        }} /></label>
        <button type="button" className={styles.button} disabled={!file || busy} onClick={() => inspect()}>Inspect file</button>
      </div>
      {raw && <>
        <p className={styles.muted}><strong>{raw.fileName}</strong> · {raw.sourceLabel} · {raw.totalRows} data rows</p>
        {raw.sheetNames.length > 1 && <label className={styles.field}><span>Excel sheet</span><select value={sheetName} disabled={busy} onChange={(event) => void inspect(event.target.value)}>{raw.sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
        <div className={styles.fieldGrid}>
          {selectField("Phone number *", "phoneColumn")}
        </div>
        <p className={styles.muted}>Only the phone number is imported. Numbers must include the country code, for example +14165550123.</p>
        <div className={styles.tableWrap}><table><thead><tr><th>Row</th>{raw.headers.map((heading, index) => <th key={index}>{heading || `Column ${index + 1}`}</th>)}</tr></thead><tbody>{raw.sample.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td>{raw.headers.map((_, index) => <td key={index}>{row.cells[index] ?? ""}</td>)}</tr>)}</tbody></table></div>
        <button type="button" className={styles.button} disabled={mapping.phoneColumn === null || busy} onClick={preview}>Preview mapped contacts</button>
      </>}
      {mapped && <>
        <div className={styles.statGrid}>
          <span><strong>{mapped.stats.validRows}</strong> valid numbers</span>
          <span><strong>{mapped.stats.invalidRows}</strong> skipped</span>
        </div>
        <div className={styles.tableWrap}><table><thead><tr><th>Row</th><th>Phone</th><th>Status</th></tr></thead><tbody>{mapped.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.phoneE164 ?? row.rawPhone}</td><td>{[...row.errors, ...row.warnings].join(" ") || "Ready"}</td></tr>)}</tbody></table></div>
        {mapped.errors.length > 0 && <p className={styles.muted}>Preview shows {mapped.errors.length} row errors{mapped.remainingErrors ? `; ${mapped.remainingErrors} more are omitted here` : ""}. Invalid rows will be skipped.</p>}
        <p className={styles.muted}>Imported numbers can be used in a campaign right away. Numbers that replied STOP are skipped.</p>
        <button type="button" className={styles.button} disabled={mapped.stats.validRows === 0 || busy} onClick={commit}>Import {mapped.stats.validRows} contacts</button>
      </>}
      {busy && <p className={styles.muted} role="status">Processing file…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {result && <p className={styles.success} role="status">{result}</p>}
      {resultBatchId && <Link className={styles.contactLink} href={`/dashboard/contacts/imports/${resultBatchId}`}>Review this upload’s consent →</Link>}
    </div>
  );
}
