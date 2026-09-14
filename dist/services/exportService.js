// ════════════════════════════════════════════════════════════════════
//  ADMIN DATA EXPORT — CSV
//  Simple, dependency-free CSV building (no xlsx tooling needed here).
// ════════════════════════════════════════════════════════════════════
import { prisma } from "./authService.js";
function csvEscape(value) {
    if (value == null)
        return "";
    const s = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows, columns) {
    const header = columns.join(",");
    const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\n");
    return header + "\n" + body + (body ? "\n" : "");
}
export async function exportAuditLogCsv() {
    const rows = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: "desc" } });
    return toCsv(rows, ["createdAt", "actorName", "actorEmail", "action", "targetType", "targetId", "summary", "detail"]);
}
export async function exportEmployeesCsv(employerId) {
    const rows = await prisma.employee.findMany({
        where: employerId ? { employerId } : {},
        select: { id: true, employerId: true, siteId: true, payrollRef: true, incomeBand: true, active: true, eligibleFrom: true, eligibleTo: true, observedAt: true, sourceUpdatedAt: true },
        take: 50000,
    });
    return toCsv(rows, ["id", "employerId", "siteId", "payrollRef", "incomeBand", "active", "eligibleFrom", "eligibleTo", "observedAt", "sourceUpdatedAt"]);
}
export async function exportDebtAccountsCsv(employerId) {
    const rows = await prisma.debtAccount.findMany({
        where: employerId ? { platformUser: { employee: { employerId } } } : {},
        select: {
            id: true, platformUserId: true, creditorName: true, creditType: true, balanceCents: true,
            inArrears: true, state: true, challengeStatus: true, observedAt: true, closedAt: true,
        },
        take: 50000,
    });
    const mapped = rows.map((r) => ({ ...r, balanceRand: (r.balanceCents / 100).toFixed(2) }));
    return toCsv(mapped, ["id", "platformUserId", "creditorName", "creditType", "balanceRand", "inArrears", "state", "challengeStatus", "observedAt", "closedAt"]);
}
export async function exportInsurancePoliciesCsv(employerId) {
    const rows = await prisma.insurancePolicy.findMany({
        where: employerId ? { platformUser: { employee: { employerId } } } : {},
        select: { id: true, platformUserId: true, type: true, premiumCents: true, isWasteful: true, isResolved: true, observedAt: true, resolvedAt: true },
        take: 50000,
    });
    const mapped = rows.map((r) => ({ ...r, premiumRand: (r.premiumCents / 100).toFixed(2) }));
    return toCsv(mapped, ["id", "platformUserId", "type", "premiumRand", "isWasteful", "isResolved", "observedAt", "resolvedAt"]);
}
export async function exportScoreSnapshotsCsv(employerId) {
    const rows = await prisma.scoreSnapshot.findMany({
        where: employerId ? { employerId } : {},
        orderBy: [{ employerId: "asc" }, { period: "desc" }],
        select: { employerId: true, period: true, optimiseScore: true, payload: true, asAt: true },
        take: 50000,
    });
    const mapped = rows.map((row) => ({
        employerId: row.employerId,
        period: row.period,
        optimiseScore: row.optimiseScore,
        headcount: typeof row.payload === "object" && row.payload !== null && "headcount" in row.payload
            ? row.payload.headcount
            : null,
        asAt: row.asAt,
    }));
    return toCsv(mapped, ["employerId", "period", "optimiseScore", "headcount", "asAt"]);
}
export async function exportUsersCsv() {
    const rows = await prisma.user.findMany({
        select: { id: true, email: true, name: true, role: true, active: true, partnerId: true, createdAt: true, revokedAt: true, revokedReason: true, revokedBy: true },
        orderBy: { createdAt: "desc" },
    });
    return toCsv(rows, ["id", "email", "name", "role", "active", "partnerId", "createdAt", "revokedAt", "revokedReason", "revokedBy"]);
}
