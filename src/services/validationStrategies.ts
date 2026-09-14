// ════════════════════════════════════════════════════════════════════
//  VALIDATION STRATEGIES
//  Split validation into early (first row, fast) and deferred (end, expensive)
//  Early: format coercion, required fields, business rules
//  Deferred: duplicate natural key detection (scans entire file)
// ════════════════════════════════════════════════════════════════════

import { ReportFormat, FieldSpec } from "./reportFormats.js";

export interface CellError {
  row: number;
  column: string;
  value: unknown;
  reason: string;
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

function parseDateTime(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function coerce(spec: FieldSpec, raw: unknown): [unknown, string | null] {
  const s = raw == null ? "" : String(raw).trim();

  if (s === "") {
    if (spec.required) return [null, "required value is missing"];
    return [null, null];
  }

  switch (spec.type) {
    case "string":
      return [s, null];

    case "int": {
      if (!/^-?\d+$/.test(s)) return [null, `expected an integer, got "${s}"`];
      const n = Number(s);
      if (!Number.isSafeInteger(n)) return [null, `integer is outside the supported range: "${s}"`];
      return [n, null];
    }

    case "decimal": {
      const normalized = s.replace(/,/g, "");
      if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return [null, `expected a decimal number, got "${s}"`];
      const n = Number(normalized);
      if (!Number.isFinite(n)) return [null, `number is outside the supported range: "${s}"`];
      return [spec.cents ? Math.round((n + Number.EPSILON) * 100) : n, null];
    }

    case "bool": {
      const v = s.toLowerCase();
      if (["true", "1", "yes", "y"].includes(v)) return [true, null];
      if (["false", "0", "no", "n"].includes(v)) return [false, null];
      return [null, `expected true/false, got "${s}"`];
    }

    case "date": {
      const d = parseDateOnly(s);
      if (!d) return [null, `expected a valid date in YYYY-MM-DD format, got "${s}"`];
      return [d, null];
    }

    case "datetime": {
      const d = parseDateTime(s);
      if (!d) return [null, `expected an ISO-8601 timestamp with timezone, got "${s}"`];
      return [d, null];
    }

    case "enum": {
      if (!spec.enumValues?.includes(s)) {
        return [null, `must be one of ${spec.enumValues?.join(", ")} — got "${s}"`];
      }
      return [s, null];
    }
  }
}

function addBusinessRules(format: ReportFormat, row: Record<string, unknown>, rowNo: number, errors: CellError[]) {
  const date = (name: string) => row[name] instanceof Date ? row[name] as Date : null;
  const num = (name: string) => typeof row[name] === "number" ? row[name] as number : null;
  const fail = (column: string, reason: string) => errors.push({ row: rowNo, column, value: row[column], reason });

  for (const [name, value] of Object.entries(row)) {
    if (typeof value !== "number") continue;
    if (["sentiment"].includes(name)) continue;
    if (value < 0) fail(name, "must not be negative");
  }

  if (num("stars") != null && (num("stars")! < 1 || num("stars")! > 5)) fail("stars", "must be between 1 and 5");
  if (num("satisfaction") != null && (num("satisfaction")! < 1 || num("satisfaction")! > 5)) fail("satisfaction", "must be between 1 and 5");
  if (num("sentiment") != null && (num("sentiment")! < -1 || num("sentiment")! > 1)) fail("sentiment", "must be between -1.0 and 1.0");

  const eligibleFrom = date("eligible_from");
  const eligibleTo = date("eligible_to");
  if (eligibleFrom && eligibleTo && eligibleTo < eligibleFrom) fail("eligible_to", "must be on or after eligible_from");
  if (format.key === "employees" && row.active === false && row.is_deleted !== true && !eligibleTo) {
    fail("eligible_to", "is required when active is false so historical eligibility has a business end date");
  }

  const enrolledAt = date("enrolled_at");
  const activatedAt = date("activated_at");
  if (enrolledAt && activatedAt && activatedAt < enrolledAt) fail("activated_at", "must be on or after enrolled_at");

  const startedAt = date("started_at");
  const completedAt = date("completed_at");
  if (startedAt && completedAt && completedAt < startedAt) fail("completed_at", "must be on or after started_at");
  if (format.key === "journeys" && row.status === "COMPLETED" && !completedAt) fail("completed_at", "is required when status is COMPLETED");

  const effectiveFrom = date("effective_from");
  const effectiveTo = date("effective_to");
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) fail("effective_to", "must be on or after effective_from");

  const observedAt = date("observed_at");
  const resolvedAt = date("resolved_at");
  if (effectiveFrom && resolvedAt && resolvedAt < effectiveFrom) fail("resolved_at", "must be on or after effective_from");
  if (observedAt && resolvedAt && row.is_resolved === true && resolvedAt > observedAt) fail("resolved_at", "cannot be after observed_at when is_resolved is true");
  const closedAt = date("closed_at");
  if (observedAt && closedAt && closedAt < observedAt) fail("closed_at", "cannot be before observed_at");

  if (format.key === "employers" && row.eligible_count != null && !date("eligible_count_as_at")) {
    fail("eligible_count_as_at", "is required when eligible_count is supplied");
  }
  if (format.key === "employers" && row.eligible_count == null && date("eligible_count_as_at")) {
    fail("eligible_count", "is required when eligible_count_as_at is supplied");
  }
  if (row.converted === true && !date("converted_at")) fail("converted_at", "is required when converted is true");
  if (row.is_resolved === true && format.key === "policies" && !date("resolved_at")) fail("resolved_at", "is required when is_resolved is true");
}

// EARLY validation: runs on first row immediately to give fast feedback
// Validates format, coercion, required fields, and immediate business rules
export function validateRecordEarly(
  format: ReportFormat,
  raw: Record<string, unknown>,
  rowNo: number,
  errors: CellError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const spec of format.fields) {
    const [value, error] = coerce(spec, raw[spec.name]);
    if (error) errors.push({ row: rowNo, column: spec.name, value: raw[spec.name], reason: error });
    else out[spec.name] = value;
  }

  addBusinessRules(format, out, rowNo, errors);
  return out;
}

// DEFERRED validation: runs at the end, checks expensive operations
// Currently: duplicate natural keys (scans entire seenKeys set)
export function validateRecordDeferred(
  format: ReportFormat,
  row: Record<string, unknown>,
  rowNo: number,
  seenKeys: Set<string>,
  errors: CellError[],
) {
  if (format.naturalKey.every((key) => row[key] != null)) {
    const keyValue = format.naturalKey.map((key) => 
      row[key] instanceof Date ? (row[key] as Date).toISOString() : String(row[key])
    ).join("∣");
    
    if (seenKeys.has(keyValue)) {
      errors.push({
        row: rowNo,
        column: format.naturalKey.join("+"),
        value: keyValue,
        reason: "duplicate natural key in file",
      });
    }
    seenKeys.add(keyValue);
  }
}

