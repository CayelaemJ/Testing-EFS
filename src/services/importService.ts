// ════════════════════════════════════════════════════════════════════
//  IMPORT SERVICE
//  CSV/XLSX/API records all enter through this idempotent upsert path.
//  source_updated_at controls last-write ordering; is_deleted is a tombstone.
// ════════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import { getFormat } from "./reportFormats.js";
import { compareDateValues, dateMillis, rehydrateStagedRows } from "./stagedRows.js";
import { validateRecordDeferred } from "./validationStrategies.js";
import { parseFile, validate, detectFormat, parseAndValidateCsvStreaming, parseAndValidateXlsxJsonStreaming, CellError } from "./importParser.js";
import { snapshotEmployer } from "./snapshotBuilder.js";
import { notifyScoreChangeIfCurrentPeriod } from "./automationService.js";

const prisma = new PrismaClient();
type Json = any;

const IMPORT_CHUNK_SIZE=Number(process.env.IMPORT_CHUNK_SIZE ?? 1000);
const IMPORT_TX_TIMEOUT_MS=Number(process.env.IMPORT_TX_TIMEOUT_MS ?? 120_000);

interface CommitOptions {
  recompute?: boolean;
}

interface CommitStats {
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isAtLeastAsNew(incoming: unknown, existing?: unknown | null): boolean {
  return !existing || dateMillis(incoming, "source_updated_at") >= dateMillis(existing, "source_updated_at");
}

function deletionTime(row: Record<string, any>): Date | null {
  return row.is_deleted ? row.source_updated_at : null;
}

// Writes validated rows into ImportBatchRow in bounded chunks instead of
// building one giant array/JSON blob for the whole file (see schema.prisma).
async function chunkedRowWriter(batchId: string) {
  let offset = 0;
  return async (rows: Record<string, unknown>[]) => {
    if (!rows.length) return;
    await prisma.importBatchRow.createMany({
      data: rows.map((data, i) => ({ batchId, rowIndex: offset + i, data: data as unknown as Json })),
    });
    offset += rows.length;
  };
}

async function loadStagedRows(batch: { id: string; stagedRows: unknown }): Promise<Record<string, unknown>[]> {
  const chunked = await prisma.importBatchRow.findMany({
    where: { batchId: batch.id },
    orderBy: { rowIndex: "asc" },
    select: { data: true },
  });
  if (chunked.length) return chunked.map((r: { data: unknown }) => r.data as Record<string, unknown>);
  // Fallback for batches from before this split (or written by syncService.ts,
  // whose API/SQL page sizes are already bounded so it still uses the blob).
  return (batch.stagedRows ?? []) as unknown as Record<string, unknown>[];
}

export async function uploadAndValidate(opts: {
  reportKey: string;
  filename: string;
  buffer: Buffer;
  uploadedBy?: string;
}) {
  const format = getFormat(opts.reportKey);
  if (!format) throw new Error(`unknown report: ${opts.reportKey}`);

  const fileFormat = detectFormat(opts.filename);

  // Reserve the batch row first so chunks can reference its id as they're
  // validated, rather than accumulating the whole file in memory and writing
  // it as one value at the end.
  const batch = await prisma.importBatch.create({
    data: { reportKey: opts.reportKey, filename: opts.filename, fileFormat, status: "UPLOADED", uploadedBy: opts.uploadedBy },
  });
  const writeChunkToDb = await chunkedRowWriter(batch.id);
  const seenNaturalKeys = new Set<string>();
  const deferredErrors: CellError[] = [];
  let stagedRowOffset = 0;

  // Run duplicate-key detection during the existing streaming pass instead of
  // reading the entire staged batch back from PostgreSQL for a second scan.
  // The previous implementation did: stream -> write -> SELECT every staged
  // row -> duplicate scan. For large uploads that extra round-trip and JSON
  // materialisation was a significant part of upload latency.
  const writeChunk = async (rows: Record<string, unknown>[]) => {
    rows.forEach((row, index) => {
      validateRecordDeferred(format, row, stagedRowOffset + index + 1, seenNaturalKeys, deferredErrors);
    });
    stagedRowOffset += rows.length;
    await writeChunkToDb(rows);
  };

  // CSV streams row-by-row and flushes chunks to ImportBatchRow as it goes —
  // this matters most here since bulk imports are almost always CSV. xlsx/json
  // also stream validated rows in bounded chunks rather than accumulating
  // into one giant array, keeping peak memory bounded for any file size.
  let result;
  if (fileFormat === "csv") {
    result = await parseAndValidateCsvStreaming(opts.buffer, format, writeChunk);
  } else {
    result = await parseAndValidateXlsxJsonStreaming(opts.buffer, fileFormat, format, writeChunk);
  }

  // Staged rows are only meaningful for a batch a user can go on to commit.
  // A failed validation has nothing to commit, so drop whatever chunks were
  // already written for it (a run of valid-looking rows before a later error).
  if (!result.ok) await prisma.importBatchRow.deleteMany({ where: { batchId: batch.id } });

  // Duplicate natural keys were checked while streaming. If any were found,
  // discard the staged rows so a failed batch can never be committed.
  if (result.ok && deferredErrors.length) {
    result = { ...result, ok: false, errors: [...result.errors, ...deferredErrors] };
    await prisma.importBatchRow.deleteMany({ where: { batchId: batch.id } });
  }

  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: result.ok ? "VALIDATED" : "FAILED",
      rowCount: result.rowCount,
      errorCount: result.errors.length + result.missingColumns.length,
      errors: result.ok
        ? undefined
        : ({ cellErrors: result.errors, missingColumns: result.missingColumns, unknownColumns: result.unknownColumns } as unknown as Json),
    },
  });

  return { batch: updated, result };
}

// Processes one bounded chunk of staged rows inside its own transaction.
// Factored out of commitBatch so a large batch can be committed as many
// short transactions instead of one that grows with the row count and
// eventually exceeds Prisma's interactive transaction timeout.
async function commitRowsChunk(
  tx: any,
  reportKey: string,
  rows: Record<string, any>[],
  stats: CommitStats,
  batchId: string,
) {
    async function employeeMap(rowsForChunk: Record<string, any>[]) {
      // Never scan the employer's entire employee table for every 1k-row
      // import chunk. Large feeds previously turned each chunk into a full
      // employee-table read, multiplying the upload/commit time by the number
      // of chunks. Restrict the lookup to the natural keys in this chunk and
      // let the composite employee index do the work.
      const keys = [...new Set(
        rowsForChunk
          .filter((row) => row.employer_ref != null && row.payroll_ref != null)
          .map((row) => `${String(row.employer_ref)}|${String(row.payroll_ref)}`),
      )];
      if (!keys.length) return { employeeIds: new Map<string, string>(), platformUserIds: new Map<string, string>() };

      const employees = await prisma.employee.findMany({
        where: {
          OR: keys.map((key) => {
            const split = key.indexOf("|");
            return {
              employerId: key.slice(0, split),
              payrollRef: key.slice(split + 1),
            };
          }),
        },
        select: { id: true, employerId: true, payrollRef: true, platformUser: { select: { id: true } } },
      });

      const employeeIds = new Map<string, string>();
      const platformUserIds = new Map<string, string>();
      for (const employee of employees) {
        const key = `${employee.employerId}|${employee.payrollRef}`;
        employeeIds.set(key, employee.id);
        if (employee.platformUser) platformUserIds.set(key, employee.platformUser.id);
      }
      return { employeeIds, platformUserIds };
    }

    switch (reportKey) {
      case "employers": {
        for (const row of rows) {
          const existing = await tx.employer.findUnique({ where: { id: row.employer_ref } });
          if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }
          const data = {
            name: row.name,
            eligibleCount: row.eligible_count ?? existing?.eligibleCount ?? 0,
            eligibleCountAsAt: row.eligible_count_as_at ?? existing?.eligibleCountAsAt ?? null,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
          };
          if (existing) {
            await tx.employer.update({ where: { id: row.employer_ref }, data });
            row.is_deleted ? stats.deleted++ : stats.updated++;
          } else {
            await tx.employer.create({ data: { id: row.employer_ref, ...data } });
            row.is_deleted ? stats.deleted++ : stats.inserted++;
          }
          // eligible_count is a current convenience cache only. Historical
          // headcount must arrive through the dedicated workforce_snapshots feed.

        }
        break;
      }

      case "workforce_snapshots": {
        for (const row of rows) {
          const where = { employerId_asOfDate: { employerId: row.employer_ref, asOfDate: row.as_of_date } };
          const existing = await tx.employerHeadcountSnapshot.findUnique({ where });
          if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }
          await tx.employerHeadcountSnapshot.upsert({
            where,
            create: {
              employerId: row.employer_ref,
              asOfDate: row.as_of_date,
              eligibleCount: row.eligible_count,
              sourceUpdatedAt: row.source_updated_at,
              sourceDeletedAt: deletionTime(row),
              importBatchId: batchId,
            },
            update: {
              eligibleCount: row.eligible_count,
              sourceUpdatedAt: row.source_updated_at,
              sourceDeletedAt: deletionTime(row),
              importBatchId: batchId,
            },
          });
          if (existing) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;

        }

        // Employer eligibleCount cache is refreshed once after the entire
        // workforce snapshot batch commits. Doing this inside every 1k-row
        // transaction caused repeated latest-snapshot scans and employer updates.
        break;
      }

      case "employees": {
        const siteKeys = new Map<string, { employerId: string; name: string }>();
        for (const row of rows) {
          if (row.site_name) siteKeys.set(`${row.employer_ref}|${row.site_name}`, { employerId: row.employer_ref, name: row.site_name });
        }
        for (const site of siteKeys.values()) {
          await tx.site.upsert({ where: { employerId_name: site }, create: site, update: {} });
        }
        const sitePairs = [...siteKeys.values()];
        const sites = sitePairs.length
          ? await tx.site.findMany({
              where: {
                OR: sitePairs.map((site) => ({ employerId: site.employerId, name: site.name })),
              },
              select: { id: true, employerId: true, name: true },
            })
          : [];
        const siteMap = new Map(sites.map((site: any) => [`${site.employerId}|${site.name}`, site.id]));

        for (const row of rows) {
          const where = { employerId_payrollRef: { employerId: row.employer_ref, payrollRef: row.payroll_ref } };
          const existing = await tx.employee.findUnique({ where });
          const versionWhere = existing
            ? { employeeId_observedAt: { employeeId: existing.id, observedAt: row.observed_at } }
            : null;
          const existingVersion = versionWhere
            ? await tx.employeeVersion.findUnique({ where: versionWhere })
            : null;
          if (existingVersion && !isAtLeastAsNew(row.source_updated_at, existingVersion.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }

          const projectionData = {
            siteId: row.site_name ? siteMap.get(`${row.employer_ref}|${row.site_name}`) ?? null : null,
            incomeBand: row.income_band ?? null,
            active: row.is_deleted ? false : (row.active ?? !row.eligible_to),
            observedAt: row.observed_at,
            eligibleFrom: row.eligible_from,
            eligibleTo: row.eligible_to ?? null,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
            importBatchId: batchId,
          };

          let employee = existing;
          if (!existing) {
            employee = await tx.employee.create({
              data: { employerId: row.employer_ref, payrollRef: row.payroll_ref, ...projectionData },
            });
          } else if (
            compareDateValues(row.observed_at, existing.observedAt, "observed_at") > 0
            || (compareDateValues(row.observed_at, existing.observedAt, "observed_at") === 0
              && isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt))
          ) {
            employee = await tx.employee.update({ where, data: projectionData });
          }

          const employeeId = employee.id;
          await tx.employeeVersion.upsert({
            where: { employeeId_observedAt: { employeeId, observedAt: row.observed_at } },
            create: {
              employeeId,
              observedAt: row.observed_at,
              siteName: row.site_name ?? null,
              incomeBand: row.income_band ?? null,
              active: row.is_deleted ? false : (row.active ?? !row.eligible_to),
              eligibleFrom: row.eligible_from,
              eligibleTo: row.eligible_to ?? null,
              isDeleted: row.is_deleted ?? false,
              sourceUpdatedAt: row.source_updated_at,
              importBatchId: batchId,
            },
            update: {
              siteName: row.site_name ?? null,
              incomeBand: row.income_band ?? null,
              active: row.is_deleted ? false : (row.active ?? !row.eligible_to),
              eligibleFrom: row.eligible_from,
              eligibleTo: row.eligible_to ?? null,
              isDeleted: row.is_deleted ?? false,
              sourceUpdatedAt: row.source_updated_at,
              importBatchId: batchId,
            },
          });
          if (existingVersion) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;
        }
        break;
      }

      case "platform_users": {
        const { employeeIds } = await employeeMap(rows);
        for (const row of rows) {
          const employeeId = employeeIds.get(`${row.employer_ref}|${row.payroll_ref}`);
          if (!employeeId) throw new Error(`platform_users references missing employee ${row.employer_ref}/${row.payroll_ref}`);
          const existing = await tx.platformUser.findUnique({ where: { employeeId } });
          if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }
          const data = {
            enrolledAt: row.enrolled_at,
            activatedAt: row.activated_at ?? null,
            hasCreditProfile: row.has_credit_profile ?? false,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
            importBatchId: batchId,
          };
          await tx.platformUser.upsert({ where: { employeeId }, create: { employeeId, ...data }, update: data });
          if (existing) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;
        }
        break;
      }

      case "journeys": {
        const { platformUserIds } = await employeeMap(rows);
        for (const row of rows) {
          const platformUserId = platformUserIds.get(`${row.employer_ref}|${row.payroll_ref}`);
          if (!platformUserId) throw new Error(`journeys references missing platform user ${row.employer_ref}/${row.payroll_ref}`);
          const existing = await tx.journey.findUnique({ where: { id: row.journey_ref } });
          if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }
          const data = {
            platformUserId,
            type: row.type,
            status: row.status,
            startedAt: row.started_at,
            completedAt: row.completed_at ?? null,
            monthlySavingCents: row.monthly_saving_rand ?? null,
            balanceImpactCents: row.balance_impact_rand ?? null,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
            importBatchId: batchId,
          };
          await tx.journey.upsert({ where: { id: row.journey_ref }, create: { id: row.journey_ref, ...data }, update: data });
          if (existing) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;
        }
        break;
      }

      case "debt_accounts": {
        const { platformUserIds } = await employeeMap(rows);
        for (const row of rows) {
          const platformUserId = platformUserIds.get(`${row.employer_ref}|${row.payroll_ref}`);
          if (!platformUserId) throw new Error(`debt_accounts references missing platform user ${row.employer_ref}/${row.payroll_ref}`);
          const existing = await tx.debtAccount.findUnique({ where: { id: row.account_ref } });
          const versionWhere = { accountId_observedAt: { accountId: row.account_ref, observedAt: row.observed_at } };
          const existingVersion = existing ? await tx.debtAccountVersion.findUnique({ where: versionWhere }) : null;
          if (existingVersion && !isAtLeastAsNew(row.source_updated_at, existingVersion.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }

          const projectionData = {
            platformUserId,
            journeyId: row.journey_ref ?? null,
            creditorName: row.creditor_name,
            creditType: row.credit_type,
            balanceCents: row.balance_rand,
            inArrears: row.in_arrears,
            state: row.state ?? "NONE",
            challengeStatus: row.challenge_status ?? null,
            observedAt: row.observed_at,
            closedAt: row.closed_at ?? null,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
            importBatchId: batchId,
          };
          if (!existing) {
            await tx.debtAccount.create({ data: { id: row.account_ref, ...projectionData } });
          } else if (
            compareDateValues(row.observed_at, existing.observedAt, "observed_at") > 0 ||
            (compareDateValues(row.observed_at, existing.observedAt, "observed_at") === 0 && isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt))
          ) {
            await tx.debtAccount.update({ where: { id: row.account_ref }, data: projectionData });
          }

          await tx.debtAccountVersion.upsert({
            where: versionWhere,
            create: {
              accountId: row.account_ref,
              observedAt: row.observed_at,
              creditorName: row.creditor_name,
              creditType: row.credit_type,
              balanceCents: row.balance_rand,
              inArrears: row.in_arrears,
              state: row.state ?? "NONE",
              challengeStatus: row.challenge_status ?? null,
              journeyId: row.journey_ref ?? null,
              closedAt: row.closed_at ?? null,
              isDeleted: row.is_deleted ?? false,
              sourceUpdatedAt: row.source_updated_at,
              importBatchId: batchId,
            },
            update: {
              creditorName: row.creditor_name,
              creditType: row.credit_type,
              balanceCents: row.balance_rand,
              inArrears: row.in_arrears,
              state: row.state ?? "NONE",
              challengeStatus: row.challenge_status ?? null,
              journeyId: row.journey_ref ?? null,
              closedAt: row.closed_at ?? null,
              isDeleted: row.is_deleted ?? false,
              sourceUpdatedAt: row.source_updated_at,
              importBatchId: batchId,
            },
          });
          if (existingVersion) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;
        }
        break;
      }

      case "policies": {
        const { platformUserIds } = await employeeMap(rows);
        for (const row of rows) {
          const platformUserId = platformUserIds.get(`${row.employer_ref}|${row.payroll_ref}`);
          if (!platformUserId) throw new Error(`policies references missing platform user ${row.employer_ref}/${row.payroll_ref}`);
          const existing = await tx.insurancePolicy.findUnique({ where: { id: row.policy_ref } });
          const versionWhere = { policyId_observedAt: { policyId: row.policy_ref, observedAt: row.observed_at } };
          const existingVersion = existing ? await tx.insurancePolicyVersion.findUnique({ where: versionWhere }) : null;
          if (existingVersion && !isAtLeastAsNew(row.source_updated_at, existingVersion.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }

          const projectionData = {
            platformUserId,
            type: row.type,
            premiumCents: row.premium_rand,
            isWasteful: row.is_wasteful,
            isResolved: row.is_resolved ?? false,
            observedAt: row.observed_at,
            effectiveFrom: row.effective_from ?? null,
            effectiveTo: row.effective_to ?? null,
            resolvedAt: row.resolved_at ?? null,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
            importBatchId: batchId,
          };
          if (!existing) {
            await tx.insurancePolicy.create({ data: { id: row.policy_ref, ...projectionData } });
          } else if (
            compareDateValues(row.observed_at, existing.observedAt, "observed_at") > 0 ||
            (compareDateValues(row.observed_at, existing.observedAt, "observed_at") === 0 && isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt))
          ) {
            await tx.insurancePolicy.update({ where: { id: row.policy_ref }, data: projectionData });
          }

          await tx.insurancePolicyVersion.upsert({
            where: versionWhere,
            create: {
              policyId: row.policy_ref,
              observedAt: row.observed_at,
              type: row.type,
              premiumCents: row.premium_rand,
              isWasteful: row.is_wasteful,
              isResolved: row.is_resolved ?? false,
              effectiveFrom: row.effective_from ?? null,
              effectiveTo: row.effective_to ?? null,
              resolvedAt: row.resolved_at ?? null,
              isDeleted: row.is_deleted ?? false,
              sourceUpdatedAt: row.source_updated_at,
              importBatchId: batchId,
            },
            update: {
              type: row.type,
              premiumCents: row.premium_rand,
              isWasteful: row.is_wasteful,
              isResolved: row.is_resolved ?? false,
              effectiveFrom: row.effective_from ?? null,
              effectiveTo: row.effective_to ?? null,
              resolvedAt: row.resolved_at ?? null,
              isDeleted: row.is_deleted ?? false,
              sourceUpdatedAt: row.source_updated_at,
              importBatchId: batchId,
            },
          });
          if (existingVersion) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;
        }
        break;
      }

      case "ratings": {
        const { platformUserIds } = await employeeMap(rows);
        for (const row of rows) {
          const platformUserId = platformUserIds.get(`${row.employer_ref}|${row.payroll_ref}`);
          if (!platformUserId) throw new Error(`ratings references missing platform user ${row.employer_ref}/${row.payroll_ref}`);
          const existing = await tx.rating.findUnique({ where: { id: row.rating_ref } });
          if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }
          const data = {
            platformUserId,
            journeyType: row.journey_type ?? null,
            stars: row.stars,
            createdAt: row.created_at,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
            importBatchId: batchId,
          };
          await tx.rating.upsert({ where: { id: row.rating_ref }, create: { id: row.rating_ref, ...data }, update: data });
          if (existing) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;
        }
        break;
      }

      case "referrals": {
        const { platformUserIds } = await employeeMap(rows);
        for (const row of rows) {
          const platformUserId = platformUserIds.get(`${row.employer_ref}|${row.payroll_ref}`);
          if (!platformUserId) throw new Error(`referrals references missing platform user ${row.employer_ref}/${row.payroll_ref}`);
          const existing = await tx.referral.findUnique({ where: { id: row.referral_ref } });
          if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }
          const data = {
            platformUserId,
            channel: row.channel ?? null,
            sharedAt: row.shared_at,
            converted: row.converted ?? false,
            convertedAt: row.converted_at ?? null,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
            importBatchId: batchId,
          };
          await tx.referral.upsert({ where: { id: row.referral_ref }, create: { id: row.referral_ref, ...data }, update: data });
          if (existing) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;
        }
        break;
      }

      case "salary_advances": {
        const { employeeIds } = await employeeMap(rows);
        for (const row of rows) {
          const employeeId = employeeIds.get(`${row.employer_ref}|${row.payroll_ref}`);
          if (!employeeId) throw new Error(`salary_advances references missing employee ${row.employer_ref}/${row.payroll_ref}`);
          const existing = await tx.salaryAdvance.findUnique({ where: { advanceRef: String(row.salary_advance_id) } });
          if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
            stats.skipped++;
            continue;
          }
          const data = {
            employerId: row.employer_ref,
            employeeId,
            clientId: String(row.client_id),
            amountCents: row.amount,
            status: row.salary_advance_status,
            bankVerified: row.bank_account_verification_status === "PASSED",
            blacklisted: row.blacklisted ?? false,
            advancedAt: row.advanced_at,
            sourceUpdatedAt: row.source_updated_at,
            sourceDeletedAt: deletionTime(row),
            importBatchId: batchId,
          };
          await tx.salaryAdvance.upsert({
            where: { advanceRef: String(row.salary_advance_id) },
            create: { advanceRef: String(row.salary_advance_id), ...data },
            update: data,
          });
          if (existing) row.is_deleted ? stats.deleted++ : stats.updated++;
          else row.is_deleted ? stats.deleted++ : stats.inserted++;
        }
        break;
      }

      default:
        throw new Error(`commit handler not implemented for report ${reportKey}`);
    }
}

export async function commitBatch(batchId: string, options: CommitOptions = {}) {
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.status !== "VALIDATED") throw new Error(`batch not in VALIDATED state (is ${batch.status})`);
  const format = getFormat(batch.reportKey);
  if (!format) throw new Error(`unknown report: ${batch.reportKey}`);
  const stagedRows = await loadStagedRows(batch);
  const rows = rehydrateStagedRows(format, stagedRows);
  const touchedEmployers = new Set<string>();
  const stats: CommitStats = { inserted: 0, updated: 0, deleted: 0, skipped: 0 };

  for (const row of rows) if (row.employer_ref) touchedEmployers.add(String(row.employer_ref));

  // Large batches commit in bounded chunks, each in its own short-lived
  // transaction, instead of one transaction spanning every row — a single
  // interactive transaction has a fixed timeout ceiling that a big enough
  // file will always eventually exceed, no matter how high it's set. Every
  // upsert below is keyed by natural key and already skips anything not
  // newer than what's stored (isAtLeastAsNew), so commit is safely
  // re-runnable: if a chunk fails partway, re-running commit on the same
  // VALIDATED batch reprocesses from the start and just re-skips whatever
  // already landed.
  const chunks: Record<string, any>[][] = [];
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) chunks.push(rows.slice(i, i + IMPORT_CHUNK_SIZE));
  // An empty batch (0 valid rows) still needs the report-key handler to run
  // once — e.g. to reject an unsupported report key the same way it always did.
  if (!chunks.length) chunks.push([]);

  for (const chunk of chunks) {
    await prisma.$transaction(
      (tx: any) => commitRowsChunk(tx, batch.reportKey, chunk, stats, batchId),
      { timeout: IMPORT_TX_TIMEOUT_MS, maxWait: 30000 },
    );
  }

  // Refresh workforce denominator caches once per affected employer, rather
  // than once per 1k-row transaction. This is a major speed-up for large
  // workforce snapshot files.
  if (batch.reportKey === "workforce_snapshots" && touchedEmployers.size) {
    await prisma.$transaction(async (tx: any) => {
      for (const employerRef of touchedEmployers) {
        const latest = await tx.employerHeadcountSnapshot.findFirst({
          where: { employerId: employerRef, sourceDeletedAt: null },
          orderBy: [{ asOfDate: "desc" }, { sourceUpdatedAt: "desc" }],
          select: { eligibleCount: true, asOfDate: true },
        });
        await tx.employer.update({
          where: { id: employerRef },
          data: {
            eligibleCount: latest?.eligibleCount ?? 0,
            eligibleCountAsAt: latest?.asOfDate ?? null,
          },
        });
      }
    });
  }

  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: "COMMITTED",
      committedAt: new Date(),
      insertedCount: stats.inserted,
      updatedCount: stats.updated,
      deletedCount: stats.deleted,
      employerRef: touchedEmployers.size === 1 ? [...touchedEmployers][0] : batch.employerRef,
    },
  });

  if (options.recompute !== false) {
    const period = currentPeriod();
    for (const employerId of touchedEmployers) {
      await snapshotEmployer(employerId, period);
      notifyScoreChangeIfCurrentPeriod(employerId, period, currentPeriod()).catch(() => {}); // best-effort, don't block the import
    }
  }

  return {
    committed: true,
    touchedEmployers: [...touchedEmployers],
    period: currentPeriod(),
    ...stats,
  };
}

export async function revertBatch(batchId: string) {
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.status !== "COMMITTED") throw new Error("only COMMITTED batches can be reverted");

  const stagedRows = (await loadStagedRows(batch)) as unknown as Record<string, any>[];
  const touchedEmployers = [...new Set(stagedRows
    .map((row) => row.employer_ref)
    .filter(Boolean)
    .map(String))];

  // Reversion is deliberately conservative. We can safely remove insert-only
  // leaf facts, plus a newly inserted employer only when nothing else depends on
  // it and the employer has not subsequently been changed by another source load.
  const insertOnly = batch.updatedCount === 0 && batch.deletedCount === 0;
  const safeLeafReports = new Set(["ratings", "referrals", "salary_advances"]);

  if (batch.reportKey === "employers") {
    if (!insertOnly) {
      throw new Error("This employer import changed existing data and cannot be safely reverted. Use a newer source record or the full pre-live reset instead.");
    }

    await prisma.$transaction(async (tx: any) => {
      for (const row of stagedRows) {
        const employerRef = String(row.employer_ref || "");
        if (!employerRef) continue;
        const employer = await tx.employer.findUnique({
          where: { id: employerRef },
          include: {
            _count: {
              select: {
                sites: true,
                employees: true,
                headcountSnapshots: true,
                scoreSnapshots: true,
                scoreWeights: true,
                targets: true,
                chatSessions: true,
                userLinks: true,
                salaryAdvances: true,
              },
            },
          },
        });
        if (!employer) continue;

        const stagedUpdatedAt = new Date(row.source_updated_at);
        if (!Number.isNaN(stagedUpdatedAt.getTime()) && employer.sourceUpdatedAt.getTime() !== stagedUpdatedAt.getTime()) {
          throw new Error(`Employer ${employerRef} has been changed since this import and cannot be reverted safely.`);
        }

        const dependencies = (Object.values(employer._count || {}) as number[]).reduce((sum, value) => sum + Number(value || 0), 0);
        if (dependencies > 0) {
          throw new Error(`Employer ${employerRef} now has linked data or user access. Revert those dependent records first, or use Reset all imported data for a clean pre-live reset.`);
        }
      }

      const employerRefs = stagedRows.map((row) => String(row.employer_ref || "")).filter(Boolean);
      if (employerRefs.length) await tx.employer.deleteMany({ where: { id: { in: employerRefs } } });
      await tx.importBatch.update({ where: { id: batchId }, data: { status: "REVERTED", revertedAt: new Date() } });
    });

    return { reverted: true, touchedEmployers, period: currentPeriod() };
  }

  if (!safeLeafReports.has(batch.reportKey) || !insertOnly) {
    throw new Error("This batch cannot be safely reverted because it is not an insert-only reversible feed. Correct it with a newer source record/tombstone, or use Reset all imported data during pre-live testing.");
  }

  await prisma.$transaction(async (tx: any) => {
    const where = { importBatchId: batchId };
    switch (batch.reportKey) {
      case "ratings":
        await tx.rating.deleteMany({ where });
        break;
      case "referrals":
        await tx.referral.deleteMany({ where });
        break;
      case "salary_advances":
        await tx.salaryAdvance.deleteMany({ where });
        break;
      default:
        throw new Error("unsupported revert report");
    }
    await tx.importBatch.update({ where: { id: batchId }, data: { status: "REVERTED", revertedAt: new Date() } });
  });

  const period = currentPeriod();
  for (const employerId of touchedEmployers) await snapshotEmployer(employerId, period);
  return { reverted: true, touchedEmployers, period };
}

export async function resetAllData() {
  const counts: Record<string, number> = {};
  await prisma.$transaction(async (tx: any) => {
    counts.ratings = (await tx.rating.deleteMany({})).count;
    // Chat is supplied by a separate source integration and is deliberately
    // excluded from the core source-data reset.
    counts.referrals = (await tx.referral.deleteMany({})).count;
    counts.salaryAdvances = (await tx.salaryAdvance.deleteMany({})).count;
    counts.policyVersions = (await tx.insurancePolicyVersion.deleteMany({})).count;
    counts.policies = (await tx.insurancePolicy.deleteMany({})).count;
    counts.debtVersions = (await tx.debtAccountVersion.deleteMany({})).count;
    counts.debtAccounts = (await tx.debtAccount.deleteMany({})).count;
    counts.journeyEvents = (await tx.journeyEvent.deleteMany({})).count;
    counts.journeys = (await tx.journey.deleteMany({})).count;
    counts.platformUsers = (await tx.platformUser.deleteMany({})).count;
    counts.employeeVersions = (await tx.employeeVersion.deleteMany({})).count;
    counts.employees = (await tx.employee.deleteMany({})).count;
    counts.sites = (await tx.site.deleteMany({})).count;
    counts.headcountSnapshots = (await tx.employerHeadcountSnapshot.deleteMany({})).count;
    counts.scoreSnapshots = (await tx.scoreSnapshot.deleteMany({})).count;
    // Partner-owned employers are configuration anchors for white-label UI,
    // access, and scheduled reports. Clear their imported facts, but keep the
    // employer shell and its partner/user relationships intact.
    counts.employers = (await tx.employer.deleteMany({ where: { partnerId: null } })).count;
    counts.batches = (await tx.importBatch.deleteMany({})).count;
    counts.cursors = (await tx.integrationCursor.deleteMany({})).count;
  }, { timeout: 120000 });
  return { reset: true, cleared: counts };
}

export { prisma };
