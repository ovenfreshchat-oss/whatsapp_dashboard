"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Download, FileSpreadsheet, UploadCloud, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useFeedback } from "@/components/ui/feedback";
import styles from "./contacts.module.css";

type RawPreview = {
  fileName: string;
  fileKind: string;
  fileSha256: string;
  sourceLabel: string;
  sheetNames: string[];
  headers: string[];
  totalRows: number;
};

type SkippedRow = { rowNumber: number; name: string | null; phone: string; reasons: string[]; codes: string[] };
type SkipReason = { code: string; label: string; count: number };

type MappedPreview = {
  fileSha256: string;
  stats: { totalRows: number; validRows: number; invalidRows: number; duplicateRows: number };
  skipped: SkippedRow[];
  skippedReasons: SkipReason[];
};

type CommitResult = {
  result: { batch_id: string; inserted: number; existing: number; rejected_rows: number };
  skipped?: SkippedRow[];
  skippedReasons?: SkipReason[];
  linkError?: string | null;
};

type Mapping = {
  phoneColumn: number | null;
  nameColumn: number | null;
  consentColumn: number | null;
  evidenceColumn: number | null;
  consentOccurredAtColumn: number | null;
  defaultCountry: string;
};

type Report = {
  fileName: string;
  inserted: number;
  existing: number;
  skipped: SkippedRow[];
  reasons: SkipReason[];
  linkError: string | null;
};

const emptyMapping: Mapping = {
  phoneColumn: null,
  nameColumn: null,
  consentColumn: null,
  evidenceColumn: null,
  consentOccurredAtColumn: null,
  defaultCountry: "",
};

const COUNTRIES: [string, string][] = [
  ["", "Numbers include the country code"],
  ["IN", "India (+91)"],
  ["US", "United States (+1)"],
  ["GB", "United Kingdom (+44)"],
  ["AE", "United Arab Emirates (+971)"],
  ["SA", "Saudi Arabia (+966)"],
  ["QA", "Qatar (+974)"],
  ["KW", "Kuwait (+965)"],
  ["OM", "Oman (+968)"],
  ["BH", "Bahrain (+973)"],
  ["SG", "Singapore (+65)"],
  ["AU", "Australia (+61)"],
];

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

async function postImport(path: string, body: FormData, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", body, credentials: "same-origin", signal });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  let value: unknown = null;
  try { value = await response.json(); } catch { /* handled below */ }
  const object = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!response.ok) throw new Error(object && typeof object.error === "string" ? object.error : "The import failed. Please try again.");
  if (!object) throw new Error("The import service returned an invalid response.");
  return value;
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  // Leading = + - @ would be run as a formula by a spreadsheet; keep it as text.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function downloadSkipped(rows: SkippedRow[], fileName: string) {
  const lines = [["Row", "Name", "Number", "Reason"].join(",")];
  for (const row of rows) lines.push([row.rowNumber, row.name, row.phone, row.reasons.join(" ")].map(csvCell).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `skipped-numbers-${fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SkippedList({ rows, reasons, fileName }: { rows: SkippedRow[]; reasons: SkipReason[]; fileName: string }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className={styles.skipBox}>
      <div className={styles.skipHead}>
        <strong>{rows.length} {rows.length === 1 ? "number" : "numbers"} skipped</strong>
        <div className={styles.actions}>
          <button type="button" className={styles.secondaryButton} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "Hide skipped numbers" : `Show skipped numbers (${rows.length})`}
          </button>
          <button type="button" className={styles.secondaryButton} onClick={() => downloadSkipped(rows, fileName)}>
            <Download size={16} aria-hidden="true" /> Download CSV
          </button>
        </div>
      </div>
      {reasons.length > 0 && <div className={styles.reasonChips}>{reasons.map((reason) => <span key={reason.code} className={styles.chip}>{reason.label}: {reason.count}</span>)}</div>}
      {open && (
        <div className={styles.skipTable} tabIndex={0} role="region" aria-label={`All ${rows.length} skipped numbers`}>
          <table>
            <thead><tr><th>Row</th><th>Name</th><th>Number</th><th>Why skipped</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.rowNumber}>
                  <td>{row.rowNumber}</td>
                  <td>{row.name ?? "—"}</td>
                  <td>{row.phone || "—"}</td>
                  <td className={styles.reasonText}>{row.reasons.join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ContactImportForm() {
  const router = useRouter();
  const { toast } = useFeedback();
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [raw, setRaw] = useState<RawPreview | null>(null);
  const [mapped, setMapped] = useState<MappedPreview | null>(null);
  const [mapping, setMapping] = useState<Mapping>(emptyMapping);
  const [importKey, setImportKey] = useState("");
  const [phase, setPhase] = useState<"idle" | "reading" | "importing">("idle");
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const busy = phase !== "idle";

  function begin(next: "reading" | "importing"): AbortSignal {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase(next);
    setError("");
    return controller.signal;
  }

  function finish() {
    abortRef.current = null;
    setPhase("idle");
  }

  /** Discard the chosen file and any preview. Nothing is imported. Also stops a request in flight. */
  function cancel() {
    const wasImporting = phase === "importing";
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
    setFile(null);
    setSheetName("");
    setRaw(null);
    setMapped(null);
    setMapping(emptyMapping);
    setImportKey("");
    setError("");
    setInputKey((value) => value + 1);
    toast({
      tone: "info",
      title: wasImporting ? "Import cancelled" : "Upload cancelled",
      message: wasImporting ? "If the import had already finished on the server, the numbers appear under Uploads." : "Nothing was imported.",
    });
    if (wasImporting) router.refresh();
  }

  async function runPreview(selected: File, nextMapping: Mapping, sheet: string, expectedHash?: string) {
    const signal = begin("reading");
    try {
      const value = await postImport("/api/contacts/import/preview", makeForm(selected, nextMapping, undefined, undefined, sheet), signal) as MappedPreview;
      if (expectedHash && value.fileSha256 !== expectedHash) throw new Error("The file changed. Choose it again.");
      setMapped({ ...value, skipped: value.skipped ?? [], skippedReasons: value.skippedReasons ?? [] });
      setImportKey(crypto.randomUUID());
    } catch (cause) {
      if (isAbort(cause)) return;
      const message = cause instanceof Error ? cause.message : "Could not preview the contacts.";
      setError(message);
      toast({ tone: "error", title: "Could not check the file", message });
    } finally {
      if (!signal.aborted) finish();
    }
  }

  /** Inspect and, when the phone column is recognised, preview in one go. */
  async function start(selected: File, selectedSheet = "") {
    const signal = begin("reading");
    setReport(null);
    setMapped(null);
    try {
      const value = await postImport("/api/contacts/import/preview", makeForm(selected, undefined, undefined, undefined, selectedSheet), signal) as RawPreview;
      const sheet = value.fileKind === "xlsx" ? value.sourceLabel : "";
      const guess = suggestedMapping(value.headers);
      setRaw(value);
      setSheetName(sheet);
      setMapping(guess);
      setImportKey("");
      if (guess.phoneColumn !== null) {
        const previewValue = await postImport("/api/contacts/import/preview", makeForm(selected, guess, undefined, undefined, sheet), signal) as MappedPreview;
        if (previewValue.fileSha256 !== value.fileSha256) throw new Error("The file changed. Choose it again.");
        setMapped({ ...previewValue, skipped: previewValue.skipped ?? [], skippedReasons: previewValue.skippedReasons ?? [] });
        setImportKey(crypto.randomUUID());
      }
    } catch (cause) {
      if (isAbort(cause)) return;
      const message = cause instanceof Error ? cause.message : "Could not read the file.";
      setError(message);
      setRaw(null);
      toast({ tone: "error", title: "Could not read the file", message });
    } finally {
      if (!signal.aborted) finish();
    }
  }

  async function commit() {
    if (!file || !raw || !mapped || !importKey || busy) return;
    const signal = begin("importing");
    try {
      const value = await postImport("/api/contacts/import/commit", makeForm(file, mapping, raw.fileSha256, importKey, sheetName), signal) as CommitResult;
      const inserted = value.result?.inserted ?? 0;
      const existing = value.result?.existing ?? 0;
      const skipped = value.skipped ?? mapped.skipped;
      const reasons = value.skippedReasons ?? mapped.skippedReasons;
      setReport({
        fileName: raw.fileName,
        inserted,
        existing,
        skipped,
        reasons,
        linkError: value.linkError ?? null,
      });
      toast({
        tone: "success",
        title: "Import complete",
        message: `${inserted} new and ${existing} existing numbers saved${skipped.length ? `; ${skipped.length} skipped` : ""}.`,
      });
      setFile(null);
      setRaw(null);
      setMapped(null);
      setImportKey("");
      setSheetName("");
      setMapping(emptyMapping);
      setInputKey((count) => count + 1);
      router.refresh();
    } catch (cause) {
      if (isAbort(cause)) return;
      const message = cause instanceof Error ? cause.message : "Could not import the contacts.";
      setError(message);
      toast({ tone: "error", title: "Import failed", message: `${message} Nothing was lost; you can try again.` });
    } finally {
      if (!signal.aborted) finish();
    }
  }

  function selectField(label: string, key: keyof Omit<Mapping, "defaultCountry">) {
    return (
      <label className={styles.field} key={key}>
        <span>{label}</span>
        <select value={mapping[key] ?? ""} disabled={busy} onChange={(event) => {
          setMapping({ ...mapping, [key]: event.target.value === "" ? null : Number(event.target.value) });
          setMapped(null);
        }}>
          <option value="">{key === "phoneColumn" ? "Select a column" : "None"}</option>
          {raw?.headers.map((heading, index) => <option key={index} value={index}>{heading || `Column ${index + 1}`}</option>)}
        </select>
      </label>
    );
  }

  const ready = Boolean(file && raw && mapped);

  return (
    <div className={styles.stack}>
      <div className={styles.dropIntro}>
        <p className={styles.muted}>CSV, Excel (.xlsx) or Word (.docx), up to 5 MiB and 5,000 rows, with a header row. A column named Phone number (and optionally Name) is picked up automatically.</p>
        <Link className={styles.contactLink} href="/templates/whatsapp-contacts-template.docx" download>Download Word template</Link>
      </div>

      {!file && (
        <label className={styles.field}>
          <span><UploadCloud size={16} aria-hidden="true" style={{ verticalAlign: "-3px", marginRight: 6 }} />Contact file</span>
          <input key={inputKey} type="file" accept=".csv,.xlsx,.docx" disabled={busy} onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setSheetName("");
            setRaw(null);
            setMapped(null);
            setMapping(emptyMapping);
            setReport(null);
            setError("");
            setFile(chosen);
            if (chosen) void start(chosen);
          }} />
        </label>
      )}

      {file && (
        <div className={styles.fileCard}>
          <span className={styles.fileIcon}><FileSpreadsheet size={20} aria-hidden="true" /></span>
          <span className={styles.fileMeta}>
            <strong>{file.name}</strong>
            <small>{fileSize(file.size)}{raw ? ` · ${raw.totalRows} rows` : ""}</small>
          </span>
          <button type="button" className={styles.secondaryButton} onClick={cancel} aria-label={`Cancel and remove ${file.name}`}>
            <X size={16} aria-hidden="true" /> Cancel
          </button>
        </div>
      )}

      {phase === "reading" && <p className={styles.progress} role="status"><Spinner /> Checking the file…</p>}

      {raw && raw.sheetNames.length > 1 && (
        <label className={styles.field}>
          <span>Excel sheet</span>
          <select value={sheetName} disabled={busy} onChange={(event) => file && void start(file, event.target.value)}>
            {raw.sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      )}

      {raw && mapping.phoneColumn === null && (
        <>
          <p className={styles.muted}>We could not tell which column holds the phone numbers. Choose it:</p>
          <div className={styles.fieldGrid}>{selectField("Phone number *", "phoneColumn")}{selectField("Name (optional)", "nameColumn")}</div>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => file && raw && mapping.phoneColumn !== null && void runPreview(file, mapping, sheetName, raw.fileSha256)}>Continue</button>
            <button type="button" className={styles.secondaryButton} onClick={cancel}>Cancel</button>
          </div>
        </>
      )}

      {raw && mapping.phoneColumn !== null && !mapped && phase === "idle" && !error && (
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => file && void runPreview(file, mapping, sheetName, raw.fileSha256)}>Preview</button>
          <button type="button" className={styles.secondaryButton} onClick={cancel}>Cancel</button>
        </div>
      )}

      {ready && mapped && (
        <>
          <label className={styles.field}>
            <span>Numbers without a country code belong to</span>
            <select value={mapping.defaultCountry} disabled={busy} onChange={(event) => {
              const next = { ...mapping, defaultCountry: event.target.value };
              setMapping(next);
              if (file) void runPreview(file, next, sheetName, raw?.fileSha256);
            }}>
              {COUNTRIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
            <small>Changing this re-checks the file. Rows that were missing a country code may then become valid.</small>
          </label>

          <div className={styles.stats}>
            <div className={`${styles.stat} ${styles.statOk}`}><strong>{mapped.stats.validRows}</strong><span>ready to import</span></div>
            <div className={`${styles.stat} ${mapped.skipped.length ? styles.statSkip : ""}`}><strong>{mapped.skipped.length}</strong><span>skipped</span></div>
            <div className={styles.stat}><strong>{mapped.stats.totalRows}</strong><span>rows in file</span></div>
          </div>

          <SkippedList rows={mapped.skipped} reasons={mapped.skippedReasons} fileName={file?.name ?? "upload"} />
          {mapped.skipped.length === 0 && <p className={styles.muted}>No rows skipped. Every row is ready to import.</p>}

          <div className={styles.sticky}>
            <button type="button" className={styles.button} disabled={mapped.stats.validRows === 0 || busy} aria-busy={phase === "importing" || undefined} onClick={commit}>
              {phase === "importing" ? <><Spinner /> Importing…</> : `Import ${mapped.stats.validRows} contacts`}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={cancel}>Cancel</button>
          </div>
          {mapped.stats.validRows === 0 && <p className={styles.error} role="alert">No valid numbers were found, so there is nothing to import. Download the skipped list to see why.</p>}
        </>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}

      {report && (
        <div className={styles.stack}>
          <p className={styles.success} role="status">
            {report.inserted + report.existing} numbers from {report.fileName} are saved ({report.inserted} new, {report.existing} already in your list). Every number in this file is in this upload&rsquo;s audience.
          </p>
          {report.linkError && <p className={styles.error} role="alert">{report.linkError}</p>}
          <SkippedList rows={report.skipped} reasons={report.reasons} fileName={report.fileName} />
          <Link className={styles.contactLink} href="/dashboard/campaigns">Create a campaign from this upload →</Link>
        </div>
      )}
    </div>
  );
}
