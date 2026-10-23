import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { DOMParser, type Element as XmlElement, type Document as XmlDocument } from "@xmldom/xmldom";
import { parse as parseCsv } from "csv-parse/sync";
import {
  ContactImportError,
  MAX_CONTACT_FILE_BYTES,
  MAX_CONTACT_IMPORT_ROWS,
  type ContactFileKind,
  type ParsedContactFile,
} from "./types";

const MAX_COLUMNS = 50;
const MAX_ZIP_ENTRIES = 300;
const MAX_ZIP_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export type ParseContactFileInput = {
  fileName: string;
  bytes: Uint8Array;
  /** Optional tab name for a workbook with more than one sheet. */
  sheetName?: string;
};

function invalid(message: string): never {
  throw new ContactImportError(message, "invalid_file");
}

function preflightOfficeArchive(bytes: Buffer): void {
  // Check central-directory sizes before any library inflates Office XML.
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50 &&
        index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
      end = index;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) {
    invalid("Office file has an invalid ZIP directory.");
  }
  const entries = bytes.readUInt16LE(end + 10);
  const directoryBytes = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  if (!entries || entries > MAX_ZIP_ENTRIES || cursor + directoryBytes > end) {
    invalid("Office file has too many or invalid ZIP entries.");
  }
  let totalInflated = 0;
  for (let entry = 0; entry < entries; entry += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      invalid("Office file has an invalid ZIP entry.");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const compression = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const inflated = bytes.readUInt32LE(cursor + 24);
    const nameBytes = bytes.readUInt16LE(cursor + 28);
    const extraBytes = bytes.readUInt16LE(cursor + 30);
    const commentBytes = bytes.readUInt16LE(cursor + 32);
    if ((flags & 1) !== 0 || ![0, 8].includes(compression) ||
        compressed === 0xffffffff || inflated === 0xffffffff ||
        inflated > 10 * 1024 * 1024 ||
        (compressed > 0 && inflated > 1024 * 1024 && inflated > compressed * 200)) {
      invalid("Office file contains an unsupported or oversized ZIP entry.");
    }
    totalInflated += inflated;
    if (totalInflated > MAX_ZIP_UNCOMPRESSED_BYTES) {
      invalid("Office file expands beyond the allowed size.");
    }
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (cursor !== bytes.readUInt32LE(end + 16) + directoryBytes) {
    invalid("Office file has an invalid ZIP directory size.");
  }
}

function cleanCell(value: string): string {
  return value.replace(/\u0000/g, "").trim();
}

function finishTable(
  table: Array<{ rowNumber: number; cells: string[] }>,
  sourceLabel: string,
  minColumns = 1,
): Pick<ParsedContactFile, "headers" | "rows" | "sourceLabel"> {
  const [first, ...rows] = table;
  if (!first || first.cells.length < minColumns || first.cells.every((cell) => !cell)) {
    invalid(minColumns > 1
      ? `The file needs a header row with at least ${minColumns} columns.`
      : "The file needs a header row with at least one column.");
  }
  if (first.cells.length > MAX_COLUMNS) invalid("The file has too many columns.");
  if (rows.length > MAX_CONTACT_IMPORT_ROWS) {
    throw new ContactImportError(`A file may contain at most ${MAX_CONTACT_IMPORT_ROWS} contact rows.`, "row_limit");
  }
  const headers = first.cells.map((header, index) => cleanCell(header).slice(0, 120) || `Column ${index + 1}`);
  return { headers, rows, sourceLabel };
}

function parseCsvFile(bytes: Buffer) {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("CSV must use UTF-8 encoding.");
  }
  let records: string[][];
  try {
    records = parseCsv(decoded, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 8_192,
      to: MAX_CONTACT_IMPORT_ROWS + 2,
    }) as string[][];
  } catch {
    invalid("CSV contains invalid rows or fields longer than 8,192 characters.");
  }
  const table = records.map((cells, index) => ({
    rowNumber: index + 1,
    cells: cells.map((cell) => cleanCell(cell)),
  }));
  if (table.some((row) => row.cells.length > MAX_COLUMNS)) invalid("The file has too many columns.");
  return finishTable(table, "CSV");
}

function excelCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value instanceof Date) {
    // Excel serial dates have no timezone. Preserve the calendar date only;
    // consent review uses a conservative date-precision ordering bound.
    return value.toISOString().slice(0, 10);
  }
  if (value && typeof value === "object" && "formula" in value) {
    const result = value.result;
    return typeof result === "string" || typeof result === "number" ? cleanCell(String(result)) : "";
  }
  return cleanCell(cell.text ?? "");
}

async function parseXlsxFile(bytes: Buffer, sheetName?: string) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    invalid("Excel workbook could not be read.");
  }
  const visibleSheets = workbook.worksheets.filter((item) => item.state === "visible");
  const sheetNames = visibleSheets.map((item) => item.name);
  const parseSheet = (sheet: ExcelJS.Worksheet, minColumns = 1) => {
    const table: Array<{ rowNumber: number; cells: string[] }> = [];
    sheet.eachRow((row, rowNumber) => {
      if (row.cellCount > MAX_COLUMNS) invalid("The sheet has too many columns.");
      const cells = Array.from({ length: row.cellCount }, (_, index) => excelCellText(row.getCell(index + 1)));
      if (cells.every((cell) => !cell)) return;
      table.push({ rowNumber, cells });
      if (table.length > MAX_CONTACT_IMPORT_ROWS + 1) {
        throw new ContactImportError(`A file may contain at most ${MAX_CONTACT_IMPORT_ROWS} contact rows.`, "row_limit");
      }
    });
    return finishTable(table, sheet.name, minColumns);
  };
  if (sheetName) {
    const selected = workbook.worksheets.find((item) => item.name === sheetName);
    if (!selected) invalid("Choose an existing visible Excel sheet.");
    if (selected.state !== "visible") invalid("Hidden Excel sheets cannot be imported.");
    return { ...parseSheet(selected), sheetNames };
  }
  let firstError: ContactImportError | undefined;
  // Prefer a sheet with several columns, so a one-column "Instructions" cover sheet is skipped.
  // A workbook whose only usable sheet has just a phone-number column is accepted on the second pass.
  for (const minColumns of [2, 1]) {
    for (const sheet of visibleSheets) {
      try {
        return { ...parseSheet(sheet, minColumns), sheetNames };
      } catch (error) {
        if (!(error instanceof ContactImportError)) throw error;
        firstError ??= error;
      }
    }
  }
  throw firstError ?? new ContactImportError("Choose an existing visible Excel sheet.", "invalid_file");
}

function wordChildren(parent: XmlElement, localName: string): XmlElement[] {
  const result: XmlElement[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 &&
        (node as XmlElement).namespaceURI === WORD_NS &&
        (node as XmlElement).localName === localName) {
      result.push(node as XmlElement);
    }
  }
  return result;
}

function wordCellText(cell: XmlElement): string {
  return Array.from(cell.getElementsByTagNameNS(WORD_NS, "p"))
    .map((paragraph) => Array.from(paragraph.getElementsByTagNameNS(WORD_NS, "t"))
      .map((textNode) => textNode.textContent ?? "").join(""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function parseDocxFile(bytes: Buffer) {
  let xml: string | undefined;
  try {
    const archive = await JSZip.loadAsync(bytes);
    xml = await archive.file("word/document.xml")?.async("string");
  } catch {
    invalid("Word document could not be read.");
  }
  if (!xml || /<!DOCTYPE/i.test(xml)) invalid("Word document has invalid XML.");
  let document: XmlDocument;
  try {
    document = new DOMParser({ onError: () => { throw new Error("Malformed Word XML"); } })
      .parseFromString(xml, "application/xml");
  } catch {
    invalid("Word document has invalid XML.");
  }
  const tables = Array.from(document.getElementsByTagNameNS(WORD_NS, "tbl"));
  // Prefer a multi-column table; accept a one-column (phone numbers only) table when none exists.
  for (const minColumns of [2, 1]) {
    for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
      const table = wordChildren(tables[tableIndex], "tr").map((row, index) => ({
        rowNumber: index + 1,
        cells: wordChildren(row, "tc").map(wordCellText),
      })).filter((row) => row.cells.some((cell) => cell));
      if (table[0]?.cells.length && table[0].cells.length >= minColumns) {
        if (table.some((row) => row.cells.length > MAX_COLUMNS)) invalid("The Word table has too many columns.");
        return finishTable(table, `Table ${tableIndex + 1}`);
      }
    }
  }
  invalid("Word document needs a table with a header row and at least one column.");
}

/** Parses the selected table only. This function never stores the original file. */
export async function parseContactFile(input: ParseContactFileInput): Promise<ParsedContactFile> {
  const fileName = input.fileName.trim();
  const kind = fileName.match(/\.(csv|xlsx|docx)$/i)?.[1]?.toLowerCase() as ContactFileKind | undefined;
  if (!kind || fileName.length > 255) {
    throw new ContactImportError("Upload a .csv, .xlsx, or .docx file.", "unsupported_file");
  }
  const bytes = Buffer.from(input.bytes);
  if (!bytes.length || bytes.length > MAX_CONTACT_FILE_BYTES) {
    throw new ContactImportError(`File must be between 1 byte and ${MAX_CONTACT_FILE_BYTES / 1024 / 1024} MiB.`, "file_size");
  }
  if (kind !== "csv") {
    preflightOfficeArchive(bytes);
  }
  const parsed = kind === "csv" ? parseCsvFile(bytes)
    : kind === "xlsx" ? await parseXlsxFile(bytes, input.sheetName)
    : await parseDocxFile(bytes);
  return {
    fileName,
    fileKind: kind,
    fileSha256: createHash("sha256").update(bytes).digest("hex"),
    ...parsed,
  };
}
