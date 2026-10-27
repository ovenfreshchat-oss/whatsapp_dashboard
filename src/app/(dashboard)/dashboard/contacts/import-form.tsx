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

// Phone number is required; a name column is picked up automatically when there is one.
function suggestedMapping(headers: string[]): Mapping {
  const matchedPhone = firstColumn(headers, /^(phone|phone number|mobile|mobile number|whatsapp|whatsapp number|number|to)$/i);
  // A one-column file can only be the phone numbers, whatever its header says.
  const phone = matchedPhone ?? (headers.length === 1 ? 0 : null);
  const name = firstColumn(headers, /^(name|full name|customer|customer name|contact|contact name)$/i);
  return { ...emptyMapping, phoneColumn: phone, nameColumn: name };
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
  const [inputKey, setInputKey] = useState(0);

  /** Inspect and, when the phone column is recognised, preview in one go. */
  /** Throw away the chosen file and any preview, so nothing is imported. */
  function cancel() {
    setFile(null);
    setSheetName("");
    setRaw(null);
    setMapped(null);
    setMapping(emptyMapping);
    setImportKey("");
    setError("");
    setResult("");
    setResultBatchId("");
    setInputKey((value) => value + 1);
  }

  async function start(selected: File, selectedSheet = "") {
    setBusy(true);
    setError("");
    setResult("");
    setResultBatchId("");
    try {
      const value = await postImport("/api/contacts/import/preview", makeForm(selected, undefined, undefined, undefined, selectedSheet)) as RawPreview;
      const sheet = value.fileKind === "xlsx" ? value.sourceLabel : "";
      const guess = suggestedMapping(value.headers);
      setRaw(value);
      setSheetName(sheet);
      setMapping(guess);
      setMapped(null);
      setImportKey("");
      if (guess.phoneColumn !== null) {
        const previewValue = await postImport("/api/contacts/import/preview", makeForm(selected, guess, undefined, undefined, sheet)) as MappedPreview;
        if (previewValue.fileSha256 !== value.fileSha256) throw new Error("The file changed. Choose it again.");
        setMapped(previewValue);
        setImportKey(crypto.randomUUID());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the file.");
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
      if (value.fileSha256 !== raw.fileSha256) throw new Error("The file changed. Choose it again.");
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
      parts[0] = `Done: ${value.result.inserted + value.result.existing} numbers saved (${value.result.inserted} new, ${value.result.existing} already in your list), ${value.result.rejected_rows} rows skipped. Every number in this file, new or existing, is in this upload's audience.`;
      setResult(parts.join(" "));
      setResultBatchId("done");
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
      <p className={styles.muted}>Choose a CSV, Excel (.xlsx) or Word (.docx) file, up to 5 MiB and 5,000 rows, with a header row. A column named Phone number (and optionally Name) is picked up automatically.</p>
      <Link className={styles.contactLink} href="/templates/whatsapp-contacts-template.docx" download>Download Word contact template (.docx) →</Link>
      <label className={styles.field}><span>Contact file</span><input key={inputKey} type="file" accept=".csv,.xlsx,.docx" onChange={(event) => {
        const chosen = event.target.files?.[0] ?? null;
        setFile(chosen);
        setSheetName("");
        setRaw(null);
        setMapped(null);
        setMapping(emptyMapping);
        setResult("");
        setResultBatchId("");
        setError("");
        if (chosen) void start(chosen);
      }} /></label>
      {raw && raw.sheetNames.length > 1 && <label className={styles.field}><span>Excel sheet</span><select value={sheetName} disabled={busy} onChange={(event) => file && void start(file, event.target.value)}>{raw.sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
      {raw && mapping.phoneColumn === null && <>
        <p className={styles.muted}>Could not tell which column has the phone numbers. Choose it:</p>
        <div className={styles.fieldGrid}>{selectField("Phone number *", "phoneColumn")}{selectField("Name (optional)", "nameColumn")}</div>
        <div className={styles.actions}><button type="button" className={styles.button} disabled={mapping.phoneColumn === null || busy} onClick={preview}>Continue</button><button type="button" className={styles.secondaryButton} disabled={busy} onClick={cancel}>Cancel</button></div>
      </>}
      {raw && mapping.phoneColumn !== null && !mapped && !busy && <div className={styles.actions}><button type="button" className={styles.button} onClick={preview}>Preview</button><button type="button" className={styles.secondaryButton} onClick={cancel}>Cancel</button></div>}
      {mapped && <>
        <div className={styles.statGrid}>
          <span><strong>{mapped.stats.validRows}</strong> valid numbers</span>
          <span><strong>{mapped.stats.invalidRows}</strong> skipped</span>
        </div>
        {(() => {
          const skipped = mapped.rows.filter((row) => row.errors.length > 0);
          return skipped.length > 0
            ? <details open><summary className={styles.muted}>Show the skipped rows</summary>
                <div className={styles.tableWrap}><table><thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Why skipped</th></tr></thead><tbody>{skipped.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.displayName ?? ""}</td><td>{row.phoneE164 ?? row.rawPhone}</td><td>{row.errors.join(" ")}</td></tr>)}</tbody></table></div>
              </details>
            : <p className={styles.muted}>No rows skipped. Every row is ready to import.</p>;
        })()}
        {mapped.errors.length > 0 && <p className={styles.muted}>{mapped.errors.length} rows have problems and will be skipped.</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={mapped.stats.validRows === 0 || busy} onClick={commit}>Import {mapped.stats.validRows} contacts</button>
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={cancel}>Cancel</button>
        </div>
      </>}
      {busy && <p className={styles.muted} role="status">Processing file…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {result && <p className={styles.success} role="status">{result}</p>}
      {resultBatchId && <Link className={styles.contactLink} href="/dashboard/campaigns">Create a campaign from this upload →</Link>}
    </div>
  );
}
