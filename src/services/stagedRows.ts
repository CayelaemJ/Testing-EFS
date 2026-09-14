import type { ReportFormat } from "./reportFormats.js";

function restoreDate(value: unknown, fieldName: string, rowNumber: number): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`staged row ${rowNumber}: ${fieldName} is not a valid date`);
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  throw new Error(`staged row ${rowNumber}: ${fieldName} is not a valid date`);
}

/**
 * Import validation intentionally produces Date objects for business dates and
 * source timestamps. ImportBatch.stagedRows is JSON, so Prisma serialises those
 * Date objects to ISO strings while the batch waits for the user to press
 * Commit. Rehydrate every temporal contract field before the commit service
 * performs date comparisons or passes values to Prisma.
 */
export function rehydrateStagedRows(
  format: ReportFormat,
  stagedRows: Record<string, unknown>[],
): Record<string, any>[] {
  const temporalFields = format.fields.filter((field) => field.type === "date" || field.type === "datetime");

  // Mutate each row in place rather than spreading into a new object per row.
  // `stagedRows` here is always a fresh object graph deserialised by Prisma
  // for this call (never shared with a caller who'd be surprised by the
  // mutation), so cloning it just to convert a few date strings back to Date
  // objects doubles the memory footprint of the whole batch for no benefit —
  // significant when a batch can be hundreds of thousands of rows.
  for (const [index, row] of stagedRows.entries()) {
    for (const field of temporalFields) {
      const value = (row as Record<string, any>)[field.name];
      if (value == null || value === "") continue;
      (row as Record<string, any>)[field.name] = restoreDate(value, field.name, index + 1);
    }
  }
  return stagedRows as Record<string, any>[];
}

export function dateMillis(value: unknown, fieldName = "date"): number {
  if (value instanceof Date) {
    const millis = value.getTime();
    if (!Number.isNaN(millis)) return millis;
  } else if (typeof value === "string" || typeof value === "number") {
    const millis = new Date(value).getTime();
    if (!Number.isNaN(millis)) return millis;
  }
  throw new Error(`${fieldName} is not a valid date`);
}

export function compareDateValues(left: unknown, right: unknown, fieldName = "date"): number {
  return dateMillis(left, fieldName) - dateMillis(right, fieldName);
}
