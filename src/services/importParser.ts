import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import { ReportFormat } from "./reportFormats.js";

export type Format = "csv" | "xlsx" | "json";

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
    if (!Array.isArray(data)) throw new Error('JSON must be array or {records:[]}');
    return data as Record<string, unknown>[];
  }

  if (format === "xlsx") {
    const wb = XLSX.read(buffer, { type: "buffer" });
    if (!wb.SheetNames.length) throw new Error("XLSX has no sheets");
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
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

// Backward compat with syncService
export function validate(format: ReportFormat, rawRows: Record<string, unknown>[]) {
  return {
    ok: rawRows.length > 0,
    rowCount: rawRows.length,
    errors: [],
    rows: rawRows.slice(0, 10),
    unknownColumns: [],
    missingColumns: [],
  };
}

