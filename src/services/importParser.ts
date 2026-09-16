// ════════════════════════════════════════════════════════════════════
//  IMPORT PARSER + VALIDATOR
//  CSV, XLSX, JSON, API and direct SQL use the same strict canonical contract.
//  Validation is split: early (format/coercion/rules on first row) and deferred
//  (duplicate detection at end to skip expensive checks during streaming).
// ════════════════════════════════════════════════════════════════════

import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import { parse as parseCsvStream } from "csv-parse";
import { ReportFormat, FieldSpec } from "./reportFormats.js";
import { validateRecordEarly, validateRecordDeferred, CellError } from "./validationStrategies.js";

export type { CellError };

export interface ValidationResult {
  ok: boolean;
  rowCount: number;
  errors: CellError[];
  rows: Record<string, unknown>[];
  unknownColumns: string[];
  missingColumns: string[];
}

type Format = "csv" | "xlsx" | "json";

export function detectFormat(filename: string): Format {
  const f = filename.toLowerCase();
  if (f.endsWith(".xlsx") || f.endsWith(".xls")) return "xlsx";
  if (f.endsWith(".json")) return "json";
  return "csv";
}

export function parseFile(buffer: Buffer, format: Format): Record<string, unknown>[] {
  if (format === "json") {
    const body = JSON.parse(buffer.toString("utf-8"));
    const data = Array.isArray(body) ? body : body?.records;
    if (!Array.isArray(data)) throw new Error('JSON import must be an array or an object containing a "records" array.');
    if (data.some((row) => row == null || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("Every JSON record must be an object.");
    }
    return data;
  }

  if (format === "xlsx") {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
    if (!wb.SheetNames.length) return [];
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  }

  return parseCsv(buffer, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    ltrim: true,
    rtrim: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

// Streaming version for XLSX and JSON that emits rows via callback to avoid
// loading the entire file into memory. Validates eagerly (first row only for
// format, defers duplicate checks to end).
export async function parseAndValidateXlsxJsonStreaming(
  buffer: Buffer,
  format: Exclude<Format, "csv">,
  reportFormat: ReportFormat,
  onRows?: (rows: Record<string, unknown>[]) => Promise<void> | void,
  chunkSize = 2000,
): Promise<ValidationResult> {
  const specByName = new Map(reportFormat.fields.map((f) => [f.name, f]));
  const errors: CellError[] = [];
  const preview: Record<string, unknown>[] = [];
  let chunk: Record<string, unknown>[] = [];
  let fileColumns: string[] | null = null;
  let rowCount = 0;

  // Parse the entire file upfront (xlsx and json libraries require this)
  const allRows = parseFile(buffer, format);

  for (const raw of allRows) {
    if (fileColumns === null) fileColumns = Object.keys(raw);
    rowCount += 1;
    
    // Validate with early strategy (coercion, business rules)
    const out = validateRecordEarly(reportFormat, raw, rowCount, errors);
    if (preview.length < 10) preview.push(out);
    
    if (onRows) {
      chunk.push(out);
      if (chunk.length >= chunkSize) {
        await onRows(chunk);
        chunk = [];
      }
    }
  }
  if (onRows && chunk.length) await onRows(chunk);

  const columns = fileColumns ?? [];
  const missingColumns = rowCount
    ? reportFormat.fields.filter((f) => f.required && !columns.includes(f.name)).map((f) => f.name)
    : [];
  const unknownColumns = columns.filter((column) => !specByName.has(column));

  const ok = errors.length === 0 && missingColumns.length === 0;
  return {
    ok,
    rowCount,
    errors,
    rows: ok ? preview : [],
    unknownColumns,
    missingColumns,
  };
}

// CSV streaming with early validation (deferred checks happen at commit time).
// This is where we really save time — CSV parsing + early validation only,
// duplicate detection happens much later when the user commits the batch.
export async function parseAndValidateCsvStreaming(
  buffer: Buffer,
  format: ReportFormat,
  onRows?: (rows: Record<string, unknown>[]) => Promise<void> | void,
  chunkSize = 2000,
): Promise<ValidationResult> {
  const specByName = new Map(format.fields.map((f) => [f.name, f]));
  const errors: CellError[] = [];
  const preview: Record<string, unknown>[] = [];
  let chunk: Record<string, unknown>[] = [];
  let fileColumns: string[] | null = null;
  let rowCount = 0;

  const parser = parseCsvStream(buffer, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    ltrim: true,
    rtrim: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  for await (const raw of parser as AsyncIterable<Record<string, unknown>>) {
    if (fileColumns === null) fileColumns = Object.keys(raw);
    rowCount += 1;
    
    // Validate with early strategy only (skip expensive duplicate checks)
    const out = validateRecordEarly(format, raw, rowCount, errors);
    if (preview.length < 10) preview.push(out);
    
    if (onRows) {
      chunk.push(out);
      if (chunk.length >= chunkSize) {
        await onRows(chunk);
        chunk = [];
      }
    }
  }
  if (onRows && chunk.length) await onRows(chunk);

  const columns = fileColumns ?? [];
  const missingColumns = rowCount
    ? format.fields.filter((f) => f.required && !columns.includes(f.name)).map((f) => f.name)
    : [];
  const unknownColumns = columns.filter((column) => !specByName.has(column));

  const ok = errors.length === 0 && missingColumns.length === 0;
  return {
    ok,
    rowCount,
    errors,
    rows: ok ? preview : [],
    unknownColumns,
    missingColumns,
  };
}

// Legacy validate function for backward compatibility with syncService.ts
// Does NOT skip duplicate checks (runs full validation)
export function validate(format: ReportFormat, rawRows: Record<string, unknown>[]): ValidationResult {
  const specByName = new Map(format.fields.map((f) => [f.name, f]));
  const fileColumns = [...new Set(rawRows.flatMap((row) => Object.keys(row)))];
  const missingColumns = rawRows.length
    ? format.fields.filter((f) => f.required && !fileColumns.includes(f.name)).map((f) => f.name)
    : [];
  const unknownColumns = fileColumns.filter((column) => !specByName.has(column));

  const errors: CellError[] = [];
  const rows: Record<string, unknown>[] = [];
  const seenKeys = new Set<string>();

  rawRows.forEach((raw, index) => {
    const out = validateRecordEarly(format, raw, index + 1, errors);
    rows.push(out);
    // Include deferred validation here for full backward compatibility
    validateRecordDeferred(format, out, index + 1, seenKeys, errors);
  });

  const ok = errors.length === 0 && missingColumns.length === 0;
  return {
    ok,
    rowCount: rawRows.length,
    errors,
    rows: ok ? rows : [],
    unknownColumns,
    missingColumns,
  };
}

// Deferred validation: run at commit time to check expensive rules
// (duplicate natural keys). Loads all rows from ImportBatchRow and validates
// them with the deferred strategy.
export async function validateBatchDeferred(
  format: ReportFormat,
  rows: Record<string, unknown>[],
): Promise<CellError[]> {
  const errors: CellError[] = [];
  const seenKeys = new Set<string>();

  rows.forEach((row, index) => {
    validateRecordDeferred(format, row, index + 1, seenKeys, errors);
  });

  return errors;
}

