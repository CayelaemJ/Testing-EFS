// ════════════════════════════════════════════════════════════════════
//  EXTERNAL SOURCE SYNC — API OR DIRECT SQL (OPTIMIZED)
//
//  Each report owns its cursor. A failed report never advances its cursor.
//  Skips Node.js validation/transformation; uses SQL stored procedures
//  for direct atomic upserts.
// ════════════════════════════════════════════════════════════════════

import { PrismaClient, Prisma } from "@prisma/client";
import { LOAD_ORDER, getFormat } from "./reportFormats.js";
import { snapshotEmployer } from "./snapshotBuilder.js";
import { notifyScoreChangeIfCurrentPeriod } from "./automationService.js";
import { createSourceAdapter, configuredSourceMode, sourceIsConfigured } from "./sourceAdapter.js";

const prisma = new PrismaClient();
type Json = Prisma.InputJsonValue;
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

function overlapCursor(value?: Date | null): Date | null {
  return value ? new Date(value.getTime() - CURSOR_OVERLAP_MS) : null;
}

// Map report keys to their stored procedure names
const SYNC_PROCS: Record<string, string> = {
  employers: "sync_upsert_employers",
  employees: "sync_upsert_employees",
  platform_users: "sync_upsert_platform_users",
  journeys: "sync_upsert_journeys",
  debt_accounts: "sync_upsert_debt_accounts",
  policies: "sync_upsert_policies",
  ratings: "sync_upsert_ratings",
  referrals: "sync_upsert_referrals",
  salary_advances: "sync_upsert_salary_advances",
  workforce_snapshots: "sync_upsert_workforce_snapshots",
};

export async function getConfig() {
  return prisma.integrationConfig.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });
}

export interface IntegrationConfigPatch {
  enabled?: boolean;
  sourceMode?: string;
  baseUrl?: string | null;
  authToken?: string | null;
  scheduleHours?: number;
  sqlDialect?: string | null;
  sqlHost?: string | null;
  sqlPort?: number | null;
  sqlDatabase?: string | null;
  sqlSchema?: string | null;
  sqlUsername?: string | null;
  sqlPassword?: string | null;
  sqlSsl?: boolean;
  sqlTrustServerCertificate?: boolean;
  sqlViewPrefix?: string | null;
  sqlQueryTimeoutMs?: number;
  sqlMaxRowsPerReport?: number;
}

export async function saveConfig(patch: IntegrationConfigPatch) {
  const data: any = { ...patch };
  if (patch.authToken === "" || patch.authToken == null) delete data.authToken;
  if (patch.sqlPassword === "" || patch.sqlPassword == null) delete data.sqlPassword;
  if (patch.sourceMode) data.sourceMode = patch.sourceMode.toUpperCase();
  if (patch.sqlDialect) data.sqlDialect = patch.sqlDialect.toUpperCase();

  return prisma.integrationConfig.upsert({
    where: { id: "default" },
    create: { id: "default", ...data },
    update: data,
  });
}

export function publicConfig(config: Awaited<ReturnType<typeof getConfig>>) {
  const { authToken, sqlPassword, ...safe } = config as any;
  let effectiveSourceMode = "API";
  let configured = false;
  try {
    effectiveSourceMode = configuredSourceMode(config);
    configured = sourceIsConfigured(config);
  } catch {
    effectiveSourceMode = String(config.sourceMode ?? "API").toUpperCase();
  }
  return {
    ...safe,
    effectiveSourceMode,
    configured,
    hasToken: Boolean(process.env.SOURCE_API_TOKEN || authToken),
    hasSqlPassword: Boolean(process.env.SOURCE_SQL_PASSWORD || sqlPassword),
    sqlPasswordFromEnvironment: Boolean(process.env.SOURCE_SQL_PASSWORD),
    apiTokenFromEnvironment: Boolean(process.env.SOURCE_API_TOKEN),
  };
}

export async function runSync(trigger: "manual" | "scheduled" = "manual") {
  const config = await getConfig();
  let configured = false;
  try { configured = sourceIsConfigured(config); }
  catch (error: any) { return { ok: false, error: error?.message ?? String(error) }; }
  if (!configured) {
    const mode = configuredSourceMode(config);
    return { ok: false, error: mode === "SQL" ? "SQL source settings are incomplete." : "No API base URL configured." };
  }

  const throughAt = new Date();
  const log = await prisma.syncLog.create({ data: { trigger, status: "RUNNING", throughAt } });
  const summary: Record<string, any> = {};
  const touchedEmployers = new Set<string>();
  let anyFailed = false;
  let anyOk = false;
  let adapter: Awaited<ReturnType<typeof createSourceAdapter>> | null = null;

  try {
    adapter = await createSourceAdapter(config);

    for (const reportKey of LOAD_ORDER) {
      const format = getFormat(reportKey);
      if (!format) continue;

      const cursor = await prisma.integrationCursor.upsert({
        where: { reportKey },
        create: { reportKey, lastAttemptAt: new Date(), lastStatus: "RUNNING" },
        update: { lastAttemptAt: new Date(), lastStatus: "RUNNING", lastNote: null },
      });

      try {
        const requestSince = overlapCursor(cursor.lastSourceUpdatedAt);
        const pulled = await adapter.fetchReport(reportKey, {
          since: requestSince,
          through: throughAt,
        });

        // Sanity check: no rows with future timestamps
        const futureSourceRows = pulled.records.filter((row: any) => row.source_updated_at > throughAt);
        if (futureSourceRows.length) {
          throw new Error(`${reportKey}: ${futureSourceRows.length} record(s) had source_updated_at later than the requested through timestamp`);
        }

        if (pulled.records.length === 0) {
          await prisma.integrationCursor.update({
            where: { reportKey },
            data: {
              lastSuccessAt: new Date(),
              lastSourceUpdatedAt: throughAt,
              lastStatus: "OK",
              lastNote: `No changed records in the requested window via ${adapter.mode}.`,
            },
          });
          summary[reportKey] = { source: pulled.location, pulled: 0, committed: 0, since: requestSince, through: throughAt };
          anyOk = true;
          continue;
        }

        // Call the stored procedure directly instead of validating/transforming
        // in Node.js. The proc handles upsert atomically in a single SQL transaction.
        const procName = SYNC_PROCS[reportKey];
        if (!procName) {
          throw new Error(`No sync procedure defined for ${reportKey}`);
        }

        const procResult = await prisma.$queryRaw<Array<{ inserted: bigint; updated: bigint; deleted: bigint }>>`
          SELECT * FROM ${Prisma.raw(procName)}(${JSON.stringify(pulled.records)}::JSONB)
        `;

        if (!procResult || procResult.length === 0) {
          throw new Error(`${reportKey}: stored procedure returned no result`);
        }

        const { inserted, updated, deleted } = procResult[0];
        const committed = Number(inserted) + Number(updated);

        await prisma.integrationCursor.update({
          where: { reportKey },
          data: {
            lastSuccessAt: new Date(),
            lastSourceUpdatedAt: throughAt,
            lastStatus: "OK",
            lastNote: `${inserted} inserted, ${updated} updated via ${adapter.mode}.`,
          },
        });

        summary[reportKey] = {
          source: pulled.location,
          pulled: pulled.records.length,
          committed,
          inserted: Number(inserted),
          updated: Number(updated),
          deleted: Number(deleted),
          since: requestSince,
          through: throughAt,
        };
        anyOk = true;
      } catch (error: any) {
        const note = error?.message ?? String(error);
        summary[reportKey] = { error: note, since: cursor.lastSourceUpdatedAt, through: throughAt };
        await prisma.integrationCursor.update({
          where: { reportKey },
          data: { lastStatus: "FAILED", lastNote: note },
        });
        anyFailed = true;
      }
    }
  } catch (error: any) {
    anyFailed = true;
    summary.source = { error: error?.message ?? String(error) };
  } finally {
    if (adapter) {
      try { await adapter.close(); }
      catch (error: any) { summary.sourceClose = { error: error?.message ?? String(error) }; anyFailed = true; }
    }
  }

  // Recompute affected employer snapshots. For now, this is empty since we're
  // not tracking which employers were modified in this sync. This can be
  // enhanced to call the proc and ask which employers it touched.
  for (const employerId of touchedEmployers) {
    try {
      const r = await snapshotEmployer(employerId);
      if (r.persisted) notifyScoreChangeIfCurrentPeriod(employerId, r.period, r.period).catch(() => {}); // best-effort
    } catch (error: any) {
      summary.snapshot = summary.snapshot ?? { errors: [] };
      summary.snapshot.errors.push({ employerId, error: error?.message ?? String(error) });
      anyFailed = true;
    }
  }

  const status = anyFailed ? (anyOk ? "PARTIAL" : "FAILED") : "OK";
  const mode = configuredSourceMode(config);
  const note = status === "OK"
    ? `All reports synced successfully from ${mode}.`
    : status === "PARTIAL"
      ? `Some ${mode} reports synced. Failed report cursors were not advanced; see details.`
      : `${mode} sync failed; no report cursor was advanced for failed feeds.`;
  const finishedAt = new Date();

  await prisma.syncLog.update({
    where: { id: log.id },
    data: { status, finishedAt, summary: summary as Json, note },
  });
  await prisma.integrationConfig.update({
    where: { id: "default" },
    data: {
      lastSyncAt: finishedAt,
      ...(status === "OK" ? { lastSuccessfulSyncAt: finishedAt } : {}),
      lastSyncStatus: status,
      lastSyncNote: note,
    },
  });

  return { ok: status !== "FAILED", status, sourceMode: mode, note, throughAt, touchedEmployers: [...touchedEmployers], summary };
}

export async function testConnection(patch: IntegrationConfigPatch = {}) {
  const saved = await getConfig();
  // Test the values currently entered in Administration without forcing the
  // user to persist them first. Blank secret fields intentionally keep the
  // saved secret (or environment-provided secret) rather than clearing it.
  const cleanPatch: IntegrationConfigPatch = { ...patch };
  if (cleanPatch.authToken === "" || cleanPatch.authToken == null) delete cleanPatch.authToken;
  if (cleanPatch.sqlPassword === "" || cleanPatch.sqlPassword == null) delete cleanPatch.sqlPassword;
  const config: any = { ...saved, ...cleanPatch };
  let adapter: Awaited<ReturnType<typeof createSourceAdapter>> | null = null;
  try {
    adapter = await createSourceAdapter(config);
    const result = await adapter.test();
    return { ...result, sourceMode: adapter.mode };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error), sourceMode: (() => { try { return configuredSourceMode(config); } catch { return "UNKNOWN"; } })() };
  } finally {
    if (adapter) {
      try { await adapter.close(); } catch {}
    }
  }
}

export async function recentSyncLogs(n = 10) {
  return prisma.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: n });
}

