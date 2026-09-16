import { PrismaClient } from "@prisma/client";
import { getFormat } from "./reportFormats.js";
import { dateMillis } from "./stagedRows.js";
import { parseFile, detectFormat } from "./importParser.js";
const prisma = new PrismaClient();
const IMPORT_CHUNK_SIZE = Number(process.env.IMPORT_CHUNK_SIZE ?? 1000);
const IMPORT_TX_TIMEOUT_MS = Number(process.env.IMPORT_TX_TIMEOUT_MS ?? 120_000);
function isAtLeastAsNew(incoming, existing) {
    return !existing || dateMillis(incoming, "source_updated_at") >= dateMillis(existing, "source_updated_at");
}
function deletionTime(row) {
    return row.is_deleted ? row.source_updated_at : null;
}
// Stage 1: Upload & Validate (NO reference checks, just structure)
export async function uploadAndValidate(opts) {
    const format = getFormat(opts.reportKey);
    if (!format)
        throw new Error(`unknown report: ${opts.reportKey}`);
    const fileFormat = detectFormat(opts.filename);
    // Parse file
    let rows = [];
    try {
        rows = parseFile(opts.buffer, fileFormat);
    }
    catch (e) {
        return {
            batch: null,
            result: {
                ok: false,
                rowCount: 0,
                errors: [],
                rows: [],
                unknownColumns: [],
                missingColumns: [],
                errorSummary: e instanceof Error ? e.message : String(e),
            },
        };
    }
    if (!rows.length) {
        return {
            batch: null,
            result: {
                ok: false,
                rowCount: 0,
                errors: [],
                rows: [],
                unknownColumns: [],
                missingColumns: [],
                errorSummary: "File is empty or contains no data rows",
            },
        };
    }
    // Create batch
    const batch = await prisma.importBatch.create({
        data: {
            reportKey: opts.reportKey,
            filename: opts.filename,
            fileFormat,
            status: "UPLOADED",
            uploadedBy: opts.uploadedBy,
            rowCount: rows.length,
        },
    });
    // Basic structural validation ONLY
    const errors = [];
    const requiredFields = format.fields.filter((f) => f.required).map((f) => f.name);
    const allFields = new Set(format.fields.map((f) => f.name));
    const fileColumns = Object.keys(rows[0] ?? {});
    const missingColumns = requiredFields.filter((col) => !fileColumns.includes(col));
    const unknownColumns = fileColumns.filter((col) => !allFields.has(col));
    if (missingColumns.length) {
        errors.push({
            row: 1,
            column: missingColumns.join(", "),
            message: `Missing required columns`,
        });
    }
    // Check for empty required fields
    rows.forEach((row, idx) => {
        requiredFields.forEach((field) => {
            const val = row[field];
            if (val === null || val === undefined || val === "") {
                errors.push({
                    row: idx + 1,
                    column: field,
                    message: `Required field is empty`,
                });
            }
        });
    });
    const ok = errors.length === 0 && missingColumns.length === 0;
    const sampleRows = rows.slice(0, 3);
    const updated = await prisma.importBatch.update({
        where: { id: batch.id },
        data: {
            status: ok ? "VALIDATED" : "FAILED",
            errorCount: errors.length,
            rowCount: rows.length,
            errors: errors.length ? { validationErrors: errors } : undefined,
            stagedRows: ok ? sampleRows : undefined,
        },
    });
    return {
        batch: updated,
        result: {
            ok,
            rowCount: rows.length,
            errors,
            rows: sampleRows,
            unknownColumns,
            missingColumns,
            errorSummary: ok ? "" : `${errors.length} validation errors`,
        },
    };
}
// Stage 2: Commit (NOW with reference checks and detailed error messages)
async function commitRowsChunk(tx, reportKey, rows, stats) {
    // Get employee map using OUTER prisma (not tx) to see committed data
    async function getEmployeeMap(rowsForChunk) {
        const keys = [...new Set(rowsForChunk
                .filter((r) => r.employer_ref != null && r.payroll_ref != null)
                .map((r) => `${String(r.employer_ref)}|${String(r.payroll_ref)}`))];
        if (!keys.length)
            return new Map();
        const employees = await prisma.employee.findMany({
            where: {
                OR: keys.map((key) => {
                    const [empId, payRef] = key.split("|");
                    return { employerId: empId, payrollRef: payRef };
                }),
            },
            select: { id: true, employerId: true, payrollRef: true, platformUser: { select: { id: true } } },
        });
        const map = new Map();
        for (const emp of employees) {
            const key = `${emp.employerId}|${emp.payrollRef}`;
            map.set(key, { id: emp.id, platformUserId: emp.platformUser?.id });
        }
        return map;
    }
    switch (reportKey) {
        case "employers":
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const existing = await tx.employer.findUnique({ where: { id: row.employer_ref } });
                if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
                    stats.skipped++;
                }
                else {
                    const data = {
                        name: row.name,
                        sourceUpdatedAt: row.source_updated_at,
                        sourceDeletedAt: deletionTime(row),
                    };
                    if (existing) {
                        await tx.employer.update({ where: { id: row.employer_ref }, data });
                        stats.updated++;
                    }
                    else {
                        await tx.employer.create({ data: { id: row.employer_ref, ...data } });
                        stats.inserted++;
                    }
                }
            }
            break;
        case "employees":
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const where = { employerId_payrollRef: { employerId: row.employer_ref, payrollRef: row.payroll_ref } };
                const existing = await tx.employee.findUnique({ where });
                if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
                    stats.skipped++;
                }
                else {
                    const data = {
                        active: row.is_deleted ? false : (row.active ?? true),
                        observedAt: row.observed_at || new Date(),
                        sourceUpdatedAt: row.source_updated_at,
                        sourceDeletedAt: deletionTime(row),
                    };
                    if (existing) {
                        await tx.employee.update({ where, data });
                        stats.updated++;
                    }
                    else {
                        await tx.employee.create({
                            data: { employerId: row.employer_ref, payrollRef: row.payroll_ref, ...data },
                        });
                        stats.inserted++;
                    }
                }
            }
            break;
        case "platform_users":
            const empMap1 = await getEmployeeMap(rows);
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const key = `${row.employer_ref}|${row.payroll_ref}`;
                const emp = empMap1.get(key);
                if (!emp)
                    throw new Error(`Row ${i + 1}: Employee ${key} not found. Import employees.csv first.`);
                const existing = await tx.platformUser.findUnique({ where: { employeeId: emp.id } });
                if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
                    stats.skipped++;
                }
                else {
                    const data = {
                        enrolledAt: row.enrolled_at || new Date(),
                        sourceUpdatedAt: row.source_updated_at,
                        sourceDeletedAt: deletionTime(row),
                    };
                    await tx.platformUser.upsert({
                        where: { employeeId: emp.id },
                        create: { employeeId: emp.id, ...data },
                        update: data,
                    });
                    existing ? stats.updated++ : stats.inserted++;
                }
            }
            break;
        case "debt_accounts":
            const empMap2 = await getEmployeeMap(rows);
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const key = `${row.employer_ref}|${row.payroll_ref}`;
                const emp = empMap2.get(key);
                if (!emp?.platformUserId)
                    throw new Error(`Row ${i + 1}: Platform user ${key} not found. Import platform_users.csv first.`);
                const existing = await tx.debtAccount.findUnique({ where: { id: row.account_ref } });
                if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
                    stats.skipped++;
                }
                else {
                    const data = {
                        platformUserId: emp.platformUserId,
                        creditorName: row.creditor_name,
                        creditType: row.credit_type,
                        balanceCents: parseInt(String(row.balance_rand)) || 0,
                        inArrears: row.in_arrears === true || row.in_arrears === "true",
                        observedAt: row.observed_at || new Date(),
                        sourceUpdatedAt: row.source_updated_at,
                        sourceDeletedAt: deletionTime(row),
                    };
                    await tx.debtAccount.upsert({
                        where: { id: row.account_ref },
                        create: { id: row.account_ref, ...data },
                        update: data,
                    });
                    existing ? stats.updated++ : stats.inserted++;
                }
            }
            break;
        case "journeys":
            const empMap3 = await getEmployeeMap(rows);
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const key = `${row.employer_ref}|${row.payroll_ref}`;
                const emp = empMap3.get(key);
                if (!emp?.platformUserId)
                    throw new Error(`Row ${i + 1}: Platform user ${key} not found. Import platform_users.csv first.`);
                const existing = await tx.journey.findUnique({ where: { id: row.journey_ref } });
                if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
                    stats.skipped++;
                }
                else {
                    const data = {
                        platformUserId: emp.platformUserId,
                        type: row.type,
                        status: row.status || "STARTED",
                        startedAt: row.started_at || new Date(),
                        sourceUpdatedAt: row.source_updated_at,
                        sourceDeletedAt: deletionTime(row),
                    };
                    await tx.journey.upsert({
                        where: { id: row.journey_ref },
                        create: { id: row.journey_ref, ...data },
                        update: data,
                    });
                    existing ? stats.updated++ : stats.inserted++;
                }
            }
            break;
        case "policies":
            const empMap4 = await getEmployeeMap(rows);
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const key = `${row.employer_ref}|${row.payroll_ref}`;
                const emp = empMap4.get(key);
                if (!emp?.platformUserId)
                    throw new Error(`Row ${i + 1}: Platform user ${key} not found. Import platform_users.csv first.`);
                const existing = await tx.insurancePolicy.findUnique({ where: { id: row.policy_ref } });
                if (existing && !isAtLeastAsNew(row.source_updated_at, existing.sourceUpdatedAt)) {
                    stats.skipped++;
                }
                else {
                    const data = {
                        platformUserId: emp.platformUserId,
                        type: row.type,
                        premiumCents: parseInt(String(row.premium_rand)) || 0,
                        sourceUpdatedAt: row.source_updated_at,
                        sourceDeletedAt: deletionTime(row),
                    };
                    await tx.insurancePolicy.upsert({
                        where: { id: row.policy_ref },
                        create: { id: row.policy_ref, ...data },
                        update: data,
                    });
                    existing ? stats.updated++ : stats.inserted++;
                }
            }
            break;
    }
}
export async function commitBatch(batchId) {
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch)
        throw new Error(`Batch not found: ${batchId}`);
    if (batch.status !== "VALIDATED")
        throw new Error(`Batch status is ${batch.status}, must be VALIDATED`);
    const allRows = (batch.stagedRows ?? []);
    if (!allRows.length)
        throw new Error("No rows staged for commit");
    const stats = { inserted: 0, updated: 0, deleted: 0, skipped: 0 };
    try {
        for (let i = 0; i < allRows.length; i += IMPORT_CHUNK_SIZE) {
            const chunk = allRows.slice(i, i + IMPORT_CHUNK_SIZE);
            const chunkNum = Math.floor(i / IMPORT_CHUNK_SIZE) + 1;
            const totalChunks = Math.ceil(allRows.length / IMPORT_CHUNK_SIZE);
            console.log(`[${batch.reportKey}] Chunk ${chunkNum}/${totalChunks}: rows ${i + 1}-${Math.min(i + IMPORT_CHUNK_SIZE, allRows.length)} of ${allRows.length}`);
            await prisma.$transaction(async (tx) => {
                await commitRowsChunk(tx, batch.reportKey, chunk, stats);
            }, { timeout: IMPORT_TX_TIMEOUT_MS });
        }
        const now = new Date();
        await prisma.importBatch.update({
            where: { id: batchId },
            data: {
                status: "COMMITTED",
                insertedCount: stats.inserted,
                updatedCount: stats.updated,
                deletedCount: stats.deleted,
                committedAt: now,
            },
        });
        return stats;
    }
    catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[${batch.reportKey}] Commit failed:`, errMsg);
        await prisma.importBatch.update({
            where: { id: batchId },
            data: {
                status: "FAILED",
                errors: {
                    commitError: errMsg,
                    rowsProcessedBefore: stats.inserted + stats.updated + stats.deleted,
                },
            },
        });
        throw error;
    }
}
export async function revertBatch(batchId) {
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    if (batch.status !== "COMMITTED")
        throw new Error("Only COMMITTED batches can be reverted");
    await prisma.importBatch.update({
        where: { id: batchId },
        data: { status: "REVERTED" },
    });
}
export async function resetAllData() {
    const counts = {};
    await prisma.$transaction(async (tx) => {
        counts.debtAccounts = (await tx.debtAccount.deleteMany({})).count;
        counts.journeys = (await tx.journey.deleteMany({})).count;
        counts.platformUsers = (await tx.platformUser.deleteMany({})).count;
        counts.employees = (await tx.employee.deleteMany({})).count;
        counts.employers = (await tx.employer.deleteMany({})).count;
    });
    return counts;
}
