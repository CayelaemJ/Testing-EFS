// ════════════════════════════════════════════════════════════════════
//  SNAPSHOT + DASHBOARD BUILDER (v2)
//
//  Stock measures are selected AS AT the filter end date.
//  Flow measures are selected INSIDE the filter window.
//  Historical payloads are complete — the frontend never fills missing live
//  values from demonstration data.
// ════════════════════════════════════════════════════════════════════

import { IncomeBand, PrismaClient } from "@prisma/client";
import { computeOptimiseScore, DEFAULT_WEIGHTS, DriverAvailability, ScoreInputs, Weights } from "./scoreEngine.js";

const prisma = new PrismaClient();

// Short-lived server-side cache: dashboard reads are read-heavy and the same
// cohort is commonly requested repeatedly while users move between tabs.
// Keep this deliberately small so slicer changes remain effectively real-time.
const DASHBOARD_CACHE_TTL_MS = 60_000;
const dashboardCache = new Map<string, { expiresAt: number; payload: any }>();

function dashboardCacheKey(employerId: string, query: DashboardQuery): string {
  return JSON.stringify([employerId, query.period ?? null, query.quarter ?? null, query.range ?? null, query.site ?? null, query.income ?? null, query.asAt ?? null]);
}

const DAY_MS = 86_400_000;
const rand = (cents: number) => cents / 100;

export type DashboardRange = "30d" | "quarter" | "all" | "month";
export interface DashboardQuery {
  period?: string;
  quarter?: string; // "YYYY-Q1".."YYYY-Q4" — a specific historical quarter, not "quarter to date"
  range?: DashboardRange | "30" | "q" | "latest";
  site?: string;
  income?: string;
  /** Internal historical anchor used for comparable relative windows. */
  asAt?: string;
}

interface ResolvedFilter {
  period: string | null;
  range: DashboardRange;
  rangeStart: Date | null;
  rangeEnd: Date;
  asAt: Date;
  site: string | null;
  income: IncomeBand | null;
  label: string;
  quarter: { year: number; q: number } | null;
}

const CREDIT_TYPE_LABEL: Record<string, string> = {
  BANK_LOAN: "Bank personal loans",
  RETAIL_STORE: "Retail / store credit",
  MICROLOAN: "Microloans",
  OTHER_UNSECURED: "Other unsecured",
};
const CREDIT_TYPE_COLOR: Record<string, string> = {
  BANK_LOAN: "#003a66",
  RETAIL_STORE: "#0078c7",
  MICROLOAN: "#e8910c",
  OTHER_UNSECURED: "#8497a7",
};
const JOURNEY_LABEL: Record<string, string> = {
  CREDIT_LIFE: "Credit Life Replacement",
  FUNERAL: "Funeral Consolidation",
  SHORT_TERM: "Short-Term Insurance Audit",
  ARREARS: "Arrears Resolution",
  PRESCRIBED: "Prescribed Debt Challenge",
  EMERGENCY: "Emergency Cash Assistance",
};
const JOURNEY_ICON: Record<string, string> = {
  CREDIT_LIFE: "shield",
  FUNERAL: "umbrella",
  SHORT_TERM: "car",
  ARREARS: "scale",
  PRESCRIBED: "scroll",
  EMERGENCY: "wallet",
};
const JOURNEY_KEY: Record<string, string> = {
  CREDIT_LIFE: "credit",
  FUNERAL: "funeral",
  SHORT_TERM: "sti",
  ARREARS: "arrears",
  PRESCRIBED: "prescribed",
  EMERGENCY: "emergency",
};
const INCOME_LABEL: Record<string, string> = {
  UNDER_5K: "Under R5k/mo",
  BAND_5_10K: "R5k–R10k/mo",
  BAND_10_20K: "R10k–R20k/mo",
  BAND_20_40K: "R20k–R40k/mo",
  OVER_40K: "Over R40k/mo",
};
const INCOME_VALUES = Object.keys(INCOME_LABEL) as IncomeBand[];
const CORE_FEEDS = [
  "employers",
  "workforce_snapshots",
  "employees",
  "platform_users",
  "journeys",
  "debt_accounts",
  "policies",
  "ratings",
  "referrals",
  "salary_advances",
] as const;
type CoreFeed = typeof CORE_FEEDS[number];

const CORE_FEED_LABELS: Record<CoreFeed, string> = {
  employers: "Employers",
  workforce_snapshots: "Workforce Headcount Snapshots",
  employees: "Employees / Workforce Eligibility",
  platform_users: "Platform Users / Enrolment",
  journeys: "Journeys & Outcomes",
  debt_accounts: "Debt Accounts",
  policies: "Insurance Policies",
  ratings: "Experience Ratings",
  referrals: "Referrals & Sharing",
  salary_advances: "Early Wage Access",
};

interface FeedCoverageEntry {
  available: boolean;
  source: "record" | "file_import" | "live_sync" | "not_loaded";
  lastSuccessAt: string | null;
}


function zar(cents: number): string {
  return "R " + Math.round(rand(cents)).toLocaleString("en-ZA");
}
function zarM(cents: number): string {
  const value = rand(cents);
  if (Math.abs(value) >= 1_000_000) return `R ${(value / 1_000_000).toFixed(2)}m`;
  if (Math.abs(value) >= 1_000) return `R ${Math.round(value / 1_000)}k`;
  return `R ${Math.round(value)}`;
}
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function startOfMonth(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}
function endOfMonth(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
}
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1]} ${year.slice(2)}`;
}
export function currentPeriod(): string {
  return monthKey(new Date());
}
// One calendar month before `period` (YYYY-MM), for month-over-month and
// quarter-over-quarter "vs last period" comparisons.
function previousPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 2, 1)); // month is 1-indexed; -2 = back one month
  return monthKey(d);
}
// The period key (YYYY-MM) of the last month of the quarter immediately
// before {year, q} — e.g. Q2 2026 -> "2026-03" (Q1 2026's close).
function previousQuarterClosePeriod({ year, q }: { year: number; q: number }): string {
  const prevQ = q === 1 ? 4 : q - 1;
  const prevYear = q === 1 ? year - 1 : year;
  const lastMonth = prevQ * 3;
  return `${prevYear}-${String(lastMonth).padStart(2, "0")}`;
}
function quarterOf(date: Date): { year: number; q: number } {
  return { year: date.getUTCFullYear(), q: Math.floor(date.getUTCMonth() / 3) + 1 };
}
function isValidPeriod(value: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5));
  return month >= 1 && month <= 12;
}
function normalizeRange(value?: string): DashboardRange {
  if (value === "30" || value === "30d") return "30d";
  if (value === "q" || value === "quarter") return "quarter";
  if (value === "month") return "month";
  return "all";
}
function parseQuarter(value: string): { year: number; q: number } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(value);
  if (!m) return null;
  return { year: Number(m[1]), q: Number(m[2]) };
}
function resolveFilter(query: DashboardQuery = {}): ResolvedFilter {
  const now = new Date();
  if (query.period && (!isValidPeriod(query.period) || query.period > currentPeriod())) {
    throw new Error("period must be a valid YYYY-MM not later than the current month");
  }
  if ([query.period, query.range, query.quarter].filter((v) => v != null).length > 1) {
    throw new Error("use period, quarter, or range — not more than one");
  }
  const quarter = query.quarter ? parseQuarter(query.quarter) : null;
  if (query.quarter && !quarter) throw new Error("quarter must be YYYY-Q1..YYYY-Q4");

  const period = query.period ?? null;
  const range = period ? "month" : quarter ? "quarter" : normalizeRange(query.range);
  if (!period && range === "month") {
    throw new Error("range=month requires period=YYYY-MM");
  }
  // A closed month is measured at month-end. Relative windows can be anchored
  // to an internal historical as-at date when calculating a prior comparable
  // window (e.g. prior 30 days). Public dashboard callers never need to set it.
  const requestedAsAt = query.asAt ? new Date(query.asAt) : null;
  if (requestedAsAt && Number.isNaN(requestedAsAt.getTime())) throw new Error("asAt must be a valid ISO date");
  const asAt = period
    ? (period === currentPeriod() ? now : endOfMonth(period))
    : (requestedAsAt && requestedAsAt <= now ? requestedAsAt : now);
  let rangeStart: Date | null = null;
  let rangeEnd = asAt;
  let label = "Programme to date";

  if (range === "month") {
    rangeStart = startOfMonth(period!);
    label = new Intl.DateTimeFormat("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" }).format(rangeStart);
    if (period === currentPeriod()) label += " (month to date)";
  } else if (range === "30d") {
    rangeStart = new Date(startOfUtcDay(asAt).getTime() - 29 * DAY_MS);
    label = "Last 30 days";
  } else if (quarter) {
    // A specific historical (or current) quarter, selected by the user — not
    // "quarter to date" relative to right now. rangeEnd is the quarter's own
    // last day, capped at now if it's the quarter still in progress, so every
    // underlying metric aggregates (sums window-filtered counts, or reads
    // point-in-time values as of quarter-end) over that quarter specifically.
    const qStartMonth = (quarter.q - 1) * 3;
    rangeStart = new Date(Date.UTC(quarter.year, qStartMonth, 1));
    const qEnd = new Date(Date.UTC(quarter.year, qStartMonth + 3, 0, 23, 59, 59, 999));
    rangeEnd = qEnd < now ? qEnd : now;
    label = `Q${quarter.q} ${quarter.year}`;
  } else if (range === "quarter") {
    const quarterMonth = Math.floor(asAt.getUTCMonth() / 3) * 3;
    rangeStart = new Date(Date.UTC(asAt.getUTCFullYear(), quarterMonth, 1));
    label = "Quarter to date";
  }

  const income = query.income && INCOME_VALUES.includes(query.income as IncomeBand)
    ? query.income as IncomeBand
    : null;
  return {
    period,
    range,
    rangeStart,
    rangeEnd,
    asAt: rangeEnd,
    site: query.site && query.site !== "all" ? query.site : null,
    income,
    label,
    quarter,
  };
}
function existsAt(sourceDeletedAt: Date | null, _asAt: Date): boolean {
  // is_deleted is a technical retraction of the natural-key record, not a
  // business lifecycle date. Business ends use eligible_to/closed_at/effective_to.
  return !sourceDeletedAt;
}
function employeeEligibleAt(employee: any, asAt: Date): boolean {
  const selectedDay = startOfUtcDay(asAt);
  return !employee.isDeleted
    && existsAt(employee.sourceDeletedAt, asAt)
    && (!employee.eligibleFrom || employee.eligibleFrom <= asAt)
    // eligible_to is a date-only, inclusive business end date.
    && (!employee.eligibleTo || employee.eligibleTo >= selectedDay);
}

async function workforceAsAt(employerId: string, asAt: Date) {
  // PostgreSQL does the expensive "latest effective-dated row" work using the
  // composite EmployeeVersion index. The previous implementation loaded every
  // version for every employee into Node and sorted it in memory — disastrous
  // at 100k+ employees.
  const rows = await prisma.$queryRaw<any[]>`
    SELECT
      e.id, e."employerId", e."siteId", e."incomeBand", e.active,
      e."observedAt", e."eligibleFrom", e."eligibleTo",
      e."sourceUpdatedAt", e."sourceDeletedAt",
      s.name AS "projectionSiteName",
      pu.id AS "platformUserId", pu."enrolledAt", pu."activatedAt",
      pu."hasCreditProfile", pu."sourceDeletedAt" AS "platformUserSourceDeletedAt",
      v."observedAt" AS "versionObservedAt",
      v."siteName" AS "versionSiteName", v."incomeBand" AS "versionIncomeBand",
      v.active AS "versionActive", v."eligibleFrom" AS "versionEligibleFrom",
      v."eligibleTo" AS "versionEligibleTo", v."sourceUpdatedAt" AS "versionSourceUpdatedAt",
      v."isDeleted" AS "versionIsDeleted"
    FROM "Employee" e
    LEFT JOIN "Site" s ON s.id = e."siteId"
    LEFT JOIN "PlatformUser" pu ON pu."employeeId" = e.id
    LEFT JOIN LATERAL (
      SELECT ev.*
      FROM "EmployeeVersion" ev
      WHERE ev."employeeId" = e.id
        AND ev."observedAt" <= ${asAt}
        AND ev."isDeleted" = false
      ORDER BY ev."observedAt" DESC, ev."sourceUpdatedAt" DESC
      LIMIT 1
    ) v ON true
    WHERE e."employerId" = ${employerId}
      AND e."sourceDeletedAt" IS NULL
  `;

  const mapped = rows.map((r: any) => {
    const hasVersion = r.versionObservedAt != null;
    const siteName = hasVersion ? r.versionSiteName : r.projectionSiteName;
    const incomeBand = hasVersion ? r.versionIncomeBand : r.incomeBand;
    const active = hasVersion ? r.versionActive : r.active;
    const observedAt = hasVersion ? r.versionObservedAt : r.observedAt;
    const eligibleFrom = hasVersion ? r.versionEligibleFrom : r.eligibleFrom;
    const eligibleTo = hasVersion ? r.versionEligibleTo : r.eligibleTo;
    const sourceUpdatedAt = hasVersion ? r.versionSourceUpdatedAt : r.sourceUpdatedAt;
    return {
      id: r.id, employerId: r.employerId, siteId: r.siteId, incomeBand, active,
      observedAt, eligibleFrom, eligibleTo, sourceUpdatedAt, sourceDeletedAt: null,
      site: siteName ? { name: siteName } : null,
      platformUser: r.platformUserId ? {
        id: r.platformUserId, enrolledAt: r.enrolledAt, activatedAt: r.activatedAt,
        hasCreditProfile: r.hasCreditProfile, sourceDeletedAt: r.platformUserSourceDeletedAt,
      } : null,
      isDeleted: Boolean(hasVersion && r.versionIsDeleted),
      workforceSource: hasVersion ? "version" : "projection",
    };
  });

  return { rows: mapped, usedFallback: mapped.some((r: any) => r.workforceSource === "projection"), missingAsAtCount: 0, versionCount: mapped.filter((r: any) => r.workforceSource === "version").length };
}

function inWindow(date: Date | null | undefined, filter: ResolvedFilter): boolean {
  return !!date && date <= filter.rangeEnd && (!filter.rangeStart || date >= filter.rangeStart);
}
function atOrBefore(date: Date | null | undefined, asAt: Date): boolean {
  return !!date && date <= asAt;
}
function wellnessBand(score: number | null): string {
  if (score == null) return "Unavailable";
  if (score >= 80) return "Strong";
  if (score >= 60) return "Improving";
  if (score >= 40) return "At risk";
  return "Critical";
}
function maxDate(values: Array<Date | null | undefined>): Date | null {
  const valid = values.filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
  return valid.length ? new Date(Math.max(...valid.map((date) => date.getTime()))) : null;
}

async function feedCoverageForEmployer(
  employerId: string,
  evidence: Partial<Record<CoreFeed, boolean>>,
): Promise<Record<CoreFeed, FeedCoverageEntry>> {
  const [cursors, batches] = await Promise.all([
    prisma.integrationCursor.findMany({
      where: { reportKey: { in: [...CORE_FEEDS] }, lastSuccessAt: { not: null } },
      select: { reportKey: true, lastSuccessAt: true },
    }),
    prisma.importBatch.findMany({
      where: { status: "COMMITTED", reportKey: { in: [...CORE_FEEDS] }, employerRef: employerId },
      orderBy: { committedAt: "desc" },
      select: { reportKey: true, committedAt: true },
    }),
  ]);

  const syncByFeed = new Map<string, Date>();
  for (const cursor of cursors as any[]) {
    if (cursor.lastSuccessAt) syncByFeed.set(cursor.reportKey, cursor.lastSuccessAt);
  }

  const importByFeed = new Map<string, Date>();
  for (const batch of batches as any[]) {
    if (!CORE_FEEDS.includes(batch.reportKey as CoreFeed)) continue;
    if (!importByFeed.has(batch.reportKey)) {
      importByFeed.set(batch.reportKey, batch.committedAt ?? new Date(0));
    }
  }

  const coverage = {} as Record<CoreFeed, FeedCoverageEntry>;
  for (const feed of CORE_FEEDS) {
    const rowEvidence = Boolean(evidence[feed]);
    const importedAt = importByFeed.get(feed);
    const syncAt = syncByFeed.get(feed);
    if (rowEvidence) {
      coverage[feed] = { available: true, source: "record", lastSuccessAt: null };
    } else if (importedAt) {
      coverage[feed] = { available: true, source: "file_import", lastSuccessAt: importedAt.toISOString() };
    } else if (syncAt) {
      // A successful API/SQL report pull is authoritative even when the result
      // for this employer is empty. That is how we distinguish a confirmed
      // zero from a feed that has never been loaded.
      coverage[feed] = { available: true, source: "live_sync", lastSuccessAt: syncAt.toISOString() };
    } else {
      coverage[feed] = { available: false, source: "not_loaded", lastSuccessAt: null };
    }
  }
  return coverage;
}

async function activeWeights(employerId: string, asAt: Date): Promise<Weights> {
  const rows = await prisma.scoreWeight.findMany({
    where: { OR: [{ employerId }, { employerId: null }], effectiveFrom: { lte: asAt } },
    orderBy: { effectiveFrom: "desc" },
  });
  const pick = (driver: string) => rows.find((row: any) => row.driver === driver && row.employerId === employerId)
    ?? rows.find((row: any) => row.driver === driver && row.employerId == null);
  return {
    ENGAGEMENT: pick("ENGAGEMENT")?.weight ?? DEFAULT_WEIGHTS.ENGAGEMENT,
    CASHFLOW: pick("CASHFLOW")?.weight ?? DEFAULT_WEIGHTS.CASHFLOW,
    DEBT_RISK: pick("DEBT_RISK")?.weight ?? DEFAULT_WEIGHTS.DEBT_RISK,
    INSURANCE: pick("INSURANCE")?.weight ?? DEFAULT_WEIGHTS.INSURANCE,
  };
}

async function latestDebtState(platformUserIds: string[], asAt: Date) {
  if (!platformUserIds.length) return { rows: [] as any[], usedFallback: false, versionCount: 0 };
  const versions = await prisma.debtAccountVersion.findMany({
    where: { account: { platformUserId: { in: platformUserIds } }, observedAt: { lte: asAt }, isDeleted: false },
    include: { account: { select: { id: true, platformUserId: true } } },
    orderBy: [{ accountId: "asc" }, { observedAt: "desc" }, { sourceUpdatedAt: "desc" }],
  });
  const latest = new Map<string, any>();
  for (const version of versions as any[]) if (!latest.has(version.accountId)) latest.set(version.accountId, version);
  const seen = new Set(latest.keys());
  const result: any[] = [];
  for (const version of latest.values()) {
    if (version.isDeleted || (version.closedAt && version.closedAt <= asAt)) continue;
    result.push({
      id: version.accountId,
      platformUserId: version.account.platformUserId,
      creditorName: version.creditorName,
      creditType: version.creditType,
      balanceCents: version.balanceCents,
      inArrears: version.inArrears,
      state: version.state,
      challengeStatus: version.challengeStatus,
      observedAt: version.observedAt,
      sourceUpdatedAt: version.sourceUpdatedAt,
    });
  }

  const projections = await prisma.debtAccount.findMany({
    where: {
      platformUserId: { in: platformUserIds },
      observedAt: { lte: asAt },
      sourceDeletedAt: null,
    },
  });
  let usedFallback = false;
  for (const account of projections as any[]) {
    if (seen.has(account.id) || (account.closedAt && account.closedAt <= asAt)) continue;
    usedFallback = true;
    result.push(account);
  }
  return { rows: result, usedFallback, versionCount: versions.length };
}

async function latestPolicyState(platformUserIds: string[], asAt: Date) {
  if (!platformUserIds.length) return { rows: [] as any[], usedFallback: false, versionCount: 0 };
  const versions = await prisma.insurancePolicyVersion.findMany({
    where: { policy: { platformUserId: { in: platformUserIds } }, observedAt: { lte: asAt }, isDeleted: false },
    include: { policy: { select: { id: true, platformUserId: true } } },
    orderBy: [{ policyId: "asc" }, { observedAt: "desc" }, { sourceUpdatedAt: "desc" }],
  });
  const latest = new Map<string, any>();
  for (const version of versions as any[]) if (!latest.has(version.policyId)) latest.set(version.policyId, version);
  const seen = new Set(latest.keys());
  const result: any[] = [];
  for (const version of latest.values()) {
    if (version.isDeleted) continue;
    if (version.effectiveFrom && version.effectiveFrom > asAt) continue;
    if (version.effectiveTo && version.effectiveTo < startOfUtcDay(asAt)) continue;
    result.push({
      id: version.policyId,
      platformUserId: version.policy.platformUserId,
      type: version.type,
      premiumCents: version.premiumCents,
      isWasteful: version.isWasteful,
      isResolved: version.resolvedAt ? version.resolvedAt <= asAt : version.isResolved,
      observedAt: version.observedAt,
      sourceUpdatedAt: version.sourceUpdatedAt,
    });
  }

  const projections = await prisma.insurancePolicy.findMany({
    where: {
      platformUserId: { in: platformUserIds },
      observedAt: { lte: asAt },
      sourceDeletedAt: null,
    },
  });
  let usedFallback = false;
  for (const policy of projections as any[]) {
    if (seen.has(policy.id)) continue;
    if (policy.effectiveFrom && policy.effectiveFrom > asAt) continue;
    if (policy.effectiveTo && policy.effectiveTo < startOfUtcDay(asAt)) continue;
    usedFallback = true;
    result.push({ ...policy, isResolved: policy.resolvedAt ? policy.resolvedAt <= asAt : policy.isResolved });
  }
  return { rows: result, usedFallback, versionCount: versions.length };
}

async function buildDashboardPayload(employerId: string, query: DashboardQuery = {}, skipPrior = false) {
  // "Latest" must mean "the most recent single period with data" — it was
  // previously falling through to range=all (a programme-to-date aggregate),
  // which barely moves as new data lands and reads as "the number doesn't
  // update". Resolve it to a real period up front, before anything else.
  let effectiveQuery: DashboardQuery = query;
  if (query.range === "latest" && !query.period) {
    const latestSnap = await prisma.scoreSnapshot.findFirst({ where: { employerId }, orderBy: { period: "desc" }, select: { period: true } });
    effectiveQuery = { ...query, range: undefined, period: latestSnap?.period ?? currentPeriod() };
  } else if ((query.range === "quarter" || query.range === "q") && !query.period && !query.quarter) {
    // Same problem, same fix as "Latest" above: "quarter to date" anchored to
    // the real wall-clock date reads as broken/empty whenever the most recent
    // actual data isn't in the real current calendar quarter (routine for
    // demo/staging data, and even in production once a business is between
    // imports). Anchor to the quarter containing the latest scored period.
    const latestSnap = await prisma.scoreSnapshot.findFirst({ where: { employerId }, orderBy: { period: "desc" }, select: { period: true } });
    const anchorPeriod = latestSnap?.period ?? currentPeriod();
    const [anchorYear, anchorMonth] = anchorPeriod.split("-").map(Number);
    const anchorQuarter = Math.floor((anchorMonth - 1) / 3) + 1;
    effectiveQuery = { ...query, range: undefined, quarter: `${anchorYear}-Q${anchorQuarter}` };
  }
  const filter = resolveFilter(effectiveQuery);
  const employer = await prisma.employer.findFirstOrThrow({ where: { id: employerId, sourceDeletedAt: null } });
  const workforceState = await workforceAsAt(employerId, filter.asAt);
  const eligibleEmployees = workforceState.rows.filter((employee: any) => employeeEligibleAt(employee, filter.asAt));
  const cohortEmployees = eligibleEmployees.filter((employee) =>
    (!filter.site || employee.site?.name === filter.site)
    && (!filter.income || employee.incomeBand === filter.income),
  );
  const employeeIds = cohortEmployees.map((employee) => employee.id);
  const platformUsers = cohortEmployees
    .map((employee) => employee.platformUser)
    .filter((user) => user && user.enrolledAt <= filter.asAt && existsAt(user.sourceDeletedAt, filter.asAt));
  const platformUserIds = platformUsers.map((user: any) => user.id);
  const employeeByPlatformUser = new Map<string, any>();
  for (const employee of cohortEmployees) if (employee.platformUser) employeeByPlatformUser.set(employee.platformUser.id, employee);

  const headcountSnapshot = !filter.site && !filter.income
    ? await prisma.employerHeadcountSnapshot.findFirst({
      where: {
        employerId,
        asOfDate: { lte: filter.asAt },
        sourceDeletedAt: null,
      },
      orderBy: { asOfDate: "desc" },
    })
    : null;
  const headcount = filter.site || filter.income
    ? cohortEmployees.length
    : (headcountSnapshot?.eligibleCount ?? (eligibleEmployees.length || employer.eligibleCount));

  const [journeys, ratingsAll, chatsAll, referralsAll, advancesAll, debtState, policyState] = await Promise.all([
    platformUserIds.length ? prisma.journey.findMany({
      where: { platformUserId: { in: platformUserIds }, startedAt: { lte: filter.asAt } },
      select: { platformUserId: true, type: true, status: true, startedAt: true, completedAt: true, monthlySavingCents: true, balanceImpactCents: true, sourceDeletedAt: true, sourceUpdatedAt: true },
    }) : [],
    platformUserIds.length ? prisma.rating.findMany({
      where: { platformUserId: { in: platformUserIds }, createdAt: { lte: filter.asAt } },
      select: { stars: true, createdAt: true, sourceDeletedAt: true, sourceUpdatedAt: true },
    }) : [],
    employeeIds.length ? prisma.chatSession.findMany({
      where: { employerId, employeeId: { in: employeeIds }, startedAt: { lte: filter.asAt } },
      select: { startedAt: true, resolvedInChat: true, satisfaction: true, firstReplySeconds: true, sourceDeletedAt: true, sourceUpdatedAt: true },
    }) : [],
    platformUserIds.length ? prisma.referral.findMany({
      where: { platformUserId: { in: platformUserIds }, sharedAt: { lte: filter.asAt } },
      select: { platformUserId: true, sharedAt: true, convertedAt: true, sourceDeletedAt: true, sourceUpdatedAt: true },
    }) : [],
    employeeIds.length ? prisma.salaryAdvance.findMany({
      where: { employerId, employeeId: { in: employeeIds }, advancedAt: { lte: filter.asAt } },
      select: { status: true, advancedAt: true, clientId: true, amountCents: true, sourceDeletedAt: true, sourceUpdatedAt: true },
    }) : [],
    latestDebtState(platformUserIds, filter.asAt),
    latestPolicyState(platformUserIds, filter.asAt),
  ]);

  const liveJourneys = (journeys as any[]).filter((journey) => existsAt(journey.sourceDeletedAt, filter.asAt));
  const cumulativeCompleted = liveJourneys.filter((journey) => journey.status === "COMPLETED" && atOrBefore(journey.completedAt, filter.asAt));
  const flowCompleted = cumulativeCompleted.filter((journey) => inWindow(journey.completedAt, filter));
  const ratings = (ratingsAll as any[]).filter((row) => existsAt(row.sourceDeletedAt, filter.asAt) && inWindow(row.createdAt, filter));
  const chats = (chatsAll as any[]).filter((row) => existsAt(row.sourceDeletedAt, filter.asAt) && inWindow(row.startedAt, filter));
  const referrals = (referralsAll as any[]).filter((row) => existsAt(row.sourceDeletedAt, filter.asAt) && inWindow(row.sharedAt, filter));
  const advances = (advancesAll as any[]).filter((row) => existsAt(row.sourceDeletedAt, filter.asAt) && row.status === "FINALISED" && inWindow(row.advancedAt, filter));
  const debts = debtState.rows;
  const policies = policyState.rows;

  // Evidence that this employer's workforce_snapshots data came from an actual
  // import (importBatchId set), not just an old convenience headcount cache row.
  // We check per-employer directly rather than via ImportBatch.employerRef,
  // because that column only holds a single employer id: any workforce_snapshots
  // file touching more than one employer (the normal case) leaves it null/stale,
  // which made every employer's feed wrongly report as "not loaded".
  const workforceSnapshotEvidence = await prisma.employerHeadcountSnapshot.findFirst({
    where: { employerId, importBatchId: { not: null } },
    select: { id: true },
  });

  const feedCoverage = await feedCoverageForEmployer(employerId, {
    employers: true,
    workforce_snapshots: Boolean(workforceSnapshotEvidence),
    employees: workforceState.rows.length > 0 || workforceState.versionCount > 0,
    platform_users: platformUsers.length > 0,
    journeys: (journeys as any[]).length > 0,
    debt_accounts: debts.length > 0 || debtState.versionCount > 0,
    policies: policies.length > 0 || policyState.versionCount > 0,
    ratings: (ratingsAll as any[]).length > 0,
    referrals: (referralsAll as any[]).length > 0,
    salary_advances: (advancesAll as any[]).length > 0,
  });

  const headcountDataAvailable = filter.site || filter.income
    ? feedCoverage.employees.available
    : (feedCoverage.workforce_snapshots.available && Boolean(headcountSnapshot)) || feedCoverage.employees.available;

  const enrolled = platformUsers.length;
  const completedUserIds = new Set(cumulativeCompleted.map((journey: any) => journey.platformUserId));
  const completedFix = completedUserIds.size;
  const completedCounts = new Map<string, number>();
  for (const journey of cumulativeCompleted as any[]) completedCounts.set(journey.platformUserId, (completedCounts.get(journey.platformUserId) ?? 0) + 1);
  const multipleFix = [...completedCounts.values()].filter((count) => count >= 2).length;
  const startedUserIds = new Set(liveJourneys.filter((journey: any) => journey.startedAt <= filter.asAt).map((journey: any) => journey.platformUserId));
  const activatedUsers = platformUsers.filter((user: any) => startedUserIds.has(user.id));
  const activated = activatedUsers.length;

  const cumulativeMonthlySaving = cumulativeCompleted.reduce((sum: number, journey: any) => sum + (journey.monthlySavingCents ?? 0), 0);
  const flowMonthlySaving = flowCompleted.reduce((sum: number, journey: any) => sum + (journey.monthlySavingCents ?? 0), 0);
  const arrearsUserIds = new Set(debts.filter((debt: any) => debt.inArrears).map((debt: any) => debt.platformUserId));
  const debtVisibleUserIds = new Set<string>();
  for (const user of platformUsers as any[]) if (user.hasCreditProfile) debtVisibleUserIds.add(user.id);
  for (const debt of debts as any[]) if (debt.platformUserId) debtVisibleUserIds.add(debt.platformUserId);
  const wastefulPolicies = policies.filter((policy: any) => policy.isWasteful);
  const fixedPolicies = wastefulPolicies.filter((policy: any) => policy.isResolved);
  // Hoisted from further down (still used there): needed now to size the
  // cashflow "still achievable" denominator below.
  const countPolicy = (type: string, unresolvedOnly = false) => policies.filter((policy: any) => policy.type === type && policy.isWasteful && (!unresolvedOnly || !policy.isResolved)).length;
  const prescribable = debts.filter((debt: any) => ["IDENTIFIED", "LETTER_SENT"].includes(debt.challengeStatus));

  // Score availability is based on the records that actually exist for the
  // selected employer/cohort/as-at period. Global integration-cursor status is
  // not a valid reason to blank a historical score: an admin can be viewing a
  // fully populated August cohort even when the latest sync cursor is stale.
  // This also makes the Region + Income slicers affect the score instead of
  // turning the entire score to null because an unrelated feed is missing.
  const driverAvailability: DriverAvailability = {
    engagement: headcountDataAvailable && headcount > 0 && platformUsers.length > 0 && liveJourneys.length > 0,
    cashflow: liveJourneys.length > 0,
    debtRisk: (debtVisibleUserIds.size > 0 || debts.length > 0) && platformUsers.length > 0,
    insurance: policies.length > 0 && platformUsers.length > 0,
  };

  // "Savings still achievable" (Optimise Score spec, driver 2 / appendix
  // section 12): eligible-but-not-yet-fixed users, per journey type, times
  // the average realised saving per completed fix of that type — the same
  // "no assumed percentage" diagnostic the Opportunities panel uses below.
  // An admin-configured AchievableTarget (actuarially reviewed) overrides
  // this when present; it must NEVER silently fall back to the unlocked
  // amount itself, since that makes the ratio trivially 100 every time no
  // target row exists (which was previously always, because nothing ever
  // writes to that table).
  const cumulativeByType = new Map<string, { count: number; saving: number }>();
  for (const journey of cumulativeCompleted as any[]) {
    const bucket = cumulativeByType.get(journey.type) ?? { count: 0, saving: 0 };
    bucket.count += 1;
    bucket.saving += journey.monthlySavingCents ?? 0;
    cumulativeByType.set(journey.type, bucket);
  }
  const overallAvgSavingCents = cumulativeCompleted.length
    ? cumulativeMonthlySaving / cumulativeCompleted.length
    : 0;
  const avgSavingForType = (type: string) => {
    const bucket = cumulativeByType.get(type);
    return bucket && bucket.count > 0 ? bucket.saving / bucket.count : overallAvgSavingCents;
  };
  const eligibleNotYetFixed: Array<[string, number]> = [
    ["ARREARS", debts.filter((debt: any) => debt.inArrears && (debt.state ?? "NONE") === "NONE").length],
    ["CREDIT_LIFE", countPolicy("CREDIT_LIFE", true)],
    ["FUNERAL", countPolicy("FUNERAL", true)],
    ["SHORT_TERM", countPolicy("SHORT_TERM", true)],
    ["PRESCRIBED", prescribable.length],
  ];
  const additionalOpportunityCents = eligibleNotYetFixed.reduce(
    (sum, [type, eligible]) => sum + eligible * avgSavingForType(type),
    0,
  );

  const targetRows = await prisma.achievableTarget.findMany({
    where: { OR: [{ employerId }, { employerId: null }], driver: "CASHFLOW", effectiveFrom: { lte: filter.asAt } },
    orderBy: { effectiveFrom: "desc" },
  });
  const target = (targetRows as any[]).find((row: any) => row.employerId === employerId)
    ?? (targetRows as any[]).find((row: any) => row.employerId == null);
  const computedAchievable = rand(cumulativeMonthlySaving) + rand(additionalOpportunityCents);
  const savingsAchievable = Number((target?.config as any)?.monthlyAchievableRand ?? computedAchievable);

  const inputs: ScoreInputs = {
    usersStartedJourney: startedUserIds.size,
    eligibleEmployees: headcount,
    savingsUnlocked: rand(cumulativeMonthlySaving),
    savingsAchievable,
    platformUsersInArrears: arrearsUserIds.size,
    platformUsers: debtVisibleUserIds.size,
    wastefulCoverFixed: fixedPolicies.length,
    wastefulCoverFound: wastefulPolicies.length,
    policiesObserved: policies.length,
  };
  const weights = await activeWeights(employerId, filter.asAt);
  const score = computeOptimiseScore(inputs, weights, driverAvailability);
  const pct = (value: number) => headcount ? Math.round((value / headcount) * 100) : 0;

  const byType = new Map<string, { count: number; saving: number; balance: number }>();
  for (const journey of flowCompleted as any[]) {
    const bucket = byType.get(journey.type) ?? { count: 0, saving: 0, balance: 0 };
    bucket.count++;
    bucket.saving += journey.monthlySavingCents ?? 0;
    bucket.balance += journey.balanceImpactCents ?? 0;
    byType.set(journey.type, bucket);
  }
  const outcomes = [...byType.entries()].map(([type, bucket]) => ({
    key: JOURNEY_KEY[type] ?? type.toLowerCase(),
    name: JOURNEY_LABEL[type] ?? type,
    meta: filter.range === "all" ? "programme-to-date completed fixes" : `${filter.label.toLowerCase()} completed fixes`,
    count: bucket.count,
    ico: JOURNEY_ICON[type] ?? "shield",
    stat: bucket.saving > 0 ? zarM(bucket.saving) : bucket.balance > 0 ? zarM(bucket.balance) : String(bucket.count),
    statL: bucket.saving > 0 ? "saved / mo" : bucket.balance > 0 ? "in resolution" : "completed",
    // Real avg per employee for this journey type — was previously hardcoded
    // per-key guess text on the frontend (e.g. always "R 298/mo" for credit
    // life regardless of what actually happened).
    avgPerEmployee: bucket.saving > 0 ? `${zar(Math.round(bucket.saving / bucket.count))}/mo` : bucket.balance > 0 ? zar(Math.round(bucket.balance / bucket.count)) : String(bucket.count),
  }));

  const arrearsDebts = debts.filter((debt: any) => debt.inArrears);
  const arrearsTotal = arrearsDebts.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0);
  const profileMap = new Map<string, number>();
  for (const debt of arrearsDebts) profileMap.set(debt.creditType, (profileMap.get(debt.creditType) ?? 0) + debt.balanceCents);
  const profileTotal = [...profileMap.values()].reduce((sum, value) => sum + value, 0);
  const debtProfile = [...profileMap.entries()].map(([creditType, balance]) => ({
    type: CREDIT_TYPE_LABEL[creditType] ?? creditType,
    balance: zarM(balance),
    pct: profileTotal ? Math.round(balance / profileTotal * 100) : 0,
    col: CREDIT_TYPE_COLOR[creditType] ?? "#8497a7",
  }));

  const creditorMap = new Map<string, { accounts: number; balance: number; states: Record<string, number> }>();
  for (const debt of arrearsDebts) {
    const bucket = creditorMap.get(debt.creditorName) ?? { accounts: 0, balance: 0, states: {} };
    bucket.accounts++;
    bucket.balance += debt.balanceCents;
    const state = debt.state ?? "NONE";
    bucket.states[state] = (bucket.states[state] ?? 0) + 1;
    creditorMap.set(debt.creditorName, bucket);
  }
  const palette = ["#e0492f", "#0078c7", "#005e9e", "#1fa463", "#8a4fc4", "#8497a7"];
  const STATE_LABEL: Record<string, string> = {
    NONE: "Not yet actioned",
    GUIDED: "Self-guided (prescription education)",
    CHALLENGED: "Prescription challenge lodged",
    ACTIVE_INTERVENTION: "Active arrangement in place",
  };
  const creditors = [...creditorMap.entries()]
    .sort((a, b) => b[1].balance - a[1].balance)
    .map(([name, bucket], index) => ({
      name,
      color: palette[index % palette.length],
      accounts: bucket.accounts,
      balance: zarM(bucket.balance),
      avg: zar(Math.round(bucket.balance / Math.max(1, bucket.accounts))),
      status: "elig",
      statusL: "In journey",
      // Real per-account state distribution for this creditor — replaces a
      // previously hardcoded "offers prepared/sent/responded" funnel on the
      // frontend that had no backing data model at all.
      stateBreakdown: Object.entries(bucket.states).map(([state, count]) => ({
        label: STATE_LABEL[state] ?? state,
        count,
        pct: Math.round((count / bucket.accounts) * 100),
      })),
    }));
  const creditorsTotal = { accounts: arrearsDebts.length, balance: zarM(arrearsTotal) };

  const stateAggregate = (state: string) => {
    const rows = debts.filter((debt: any) => debt.state === state);
    return {
      rand: rows.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0),
      employees: new Set(rows.map((debt: any) => debt.platformUserId)).size,
    };
  };
  const active = stateAggregate("ACTIVE_INTERVENTION");
  const challenged = stateAggregate("CHALLENGED");
  const guided = stateAggregate("GUIDED");

  const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const rating of ratings) ratingDistribution[rating.stars] = (ratingDistribution[rating.stars] ?? 0) + 1;
  const ratingResponses = ratings.length;
  const avgRating = ratingResponses ? ratings.reduce((sum: number, rating: any) => sum + rating.stars, 0) / ratingResponses : 0;
  const ratingPct: Record<number, number> = {};
  for (let stars = 1; stars <= 5; stars++) ratingPct[stars] = ratingResponses ? Math.round(ratingDistribution[stars] / ratingResponses * 100) : 0;
  const fiveStarPct = ratingPct[5];
  const nps = ratingResponses ? Math.round((ratingDistribution[5] / ratingResponses - (ratingDistribution[1] + ratingDistribution[2] + ratingDistribution[3]) / ratingResponses) * 100) : null;

  const challengeRows = debts.filter((debt: any) => debt.challengeStatus);
  const challengeOrder = ["IDENTIFIED", "LETTER_SENT", "CREDITOR_CONCEDED", "WRITTEN_OFF"];
  const stageCount = (stage: string) => challengeRows.filter((debt: any) => challengeOrder.indexOf(debt.challengeStatus) >= challengeOrder.indexOf(stage)).length;
  const challengedBalance = challengeRows.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0);
  const writtenOffBalance = challengeRows.filter((debt: any) => debt.challengeStatus === "WRITTEN_OFF").reduce((sum: number, debt: any) => sum + debt.balanceCents, 0);

  const incomeColors = ["#003a66", "#0078c7", "#4ea3da", "#bfe0f5", "#8497a7"];
  const incomeCounts = new Map<string, number>();
  for (const user of activatedUsers as any[]) {
    const employee = employeeByPlatformUser.get(user.id);
    if (!employee?.incomeBand) continue;
    incomeCounts.set(employee.incomeBand, (incomeCounts.get(employee.incomeBand) ?? 0) + 1);
  }
  const income = [...incomeCounts.entries()].map(([band, count], index) => ({
    value: band,
    name: INCOME_LABEL[band] ?? band,
    count,
    color: incomeColors[index % incomeColors.length],
  }));

  const chatTotal = chats.length;
  const chatResolved = chats.filter((chat: any) => chat.resolvedInChat).length;
  const chatCsatRows = chats.filter((chat: any) => chat.satisfaction != null);
  const chatCsat = chatCsatRows.length ? chatCsatRows.reduce((sum: number, chat: any) => sum + chat.satisfaction, 0) / chatCsatRows.length : 0;
  const replyTimes = chats.filter((chat: any) => chat.firstReplySeconds != null).map((chat: any) => chat.firstReplySeconds).sort((a: number, b: number) => a - b);
  const medianReply = replyTimes.length ? replyTimes[Math.floor((replyTimes.length - 1) / 2)] : 0;
  const chatByType = new Map<string, { convos: number; sentimentTotal: number; sentimentCount: number; themes: Map<string, number> }>();
  const questionCounts = new Map<string, { count: number; journey: string }>();
  const weekCounts = new Map<string, number>();
  for (const chat of chats as any[]) {
    const key = chat.journeyType ?? "GENERAL";
    const bucket = chatByType.get(key) ?? { convos: 0, sentimentTotal: 0, sentimentCount: 0, themes: new Map() };
    bucket.convos++;
    if (chat.sentiment != null) { bucket.sentimentTotal += chat.sentiment; bucket.sentimentCount++; }
    if (chat.theme) bucket.themes.set(chat.theme, (bucket.themes.get(chat.theme) ?? 0) + 1);
    chatByType.set(key, bucket);
    if (chat.primaryQuestion) {
      const question = questionCounts.get(chat.primaryQuestion) ?? { count: 0, journey: JOURNEY_LABEL[key] ?? "General" };
      question.count++;
      questionCounts.set(chat.primaryQuestion, question);
    }
    const week = new Date(chat.startedAt);
    const day = (week.getUTCDay() + 6) % 7;
    week.setUTCDate(week.getUTCDate() - day);
    const keyWeek = week.toISOString().slice(0, 10);
    weekCounts.set(keyWeek, (weekCounts.get(keyWeek) ?? 0) + 1);
  }
  const chatByJourney = [...chatByType.entries()].sort((a, b) => b[1].convos - a[1].convos).map(([key, bucket]) => ({
    key: key.toLowerCase(),
    name: JOURNEY_LABEL[key] ?? "General / account",
    convos: bucket.convos,
    pct: chatTotal ? Math.round(bucket.convos / chatTotal * 100) : 0,
    sentiment: bucket.sentimentCount ? Math.round(((bucket.sentimentTotal / bucket.sentimentCount) + 1) / 2 * 100) : 0,
    themes: [...bucket.themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([theme, count]) => ({ t: theme, n: count })),
  }));
  const chatTrending = [...questionCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6).map(([question, value]) => ({ q: question, n: value.count, journey: value.journey, trend: "flat" }));
  const chatVolume = [...weekCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-10).map((entry) => entry[1]);

  const sharers = new Set(referrals.map((referral: any) => referral.platformUserId)).size;
  const completedFlowUsers = new Set(flowCompleted.map((journey: any) => journey.platformUserId)).size;
  const channelCounts = new Map<string, number>();
  for (const referral of referrals as any[]) if (referral.channel) channelCounts.set(referral.channel, (channelCounts.get(referral.channel) ?? 0) + 1);
  const topChannel = [...channelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
  const referral = {
    shares: referrals.length,
    shareRate: completedFlowUsers ? Math.round(sharers / completedFlowUsers * 100) : 0,
    channel: topChannel,
    impliedReach: referrals.length ? `≈ ${(referrals.length * 3).toLocaleString("en-ZA")}` : "—",
  };

  const ewaClients = new Set(advances.map((advance: any) => advance.clientId)).size;
  const ewaTotal = advances.reduce((sum: number, advance: any) => sum + advance.amountCents, 0);
  const ewaByMonth = new Map<string, number>();
  for (const advance of advances as any[]) ewaByMonth.set(monthKey(advance.advancedAt), (ewaByMonth.get(monthKey(advance.advancedAt)) ?? 0) + advance.amountCents);
  const ewaMonths = [...ewaByMonth.keys()].sort().slice(-12);
  const ewa = {
    clients: ewaClients,
    advances: advances.length,
    total: zar(ewaTotal),
    totalRaw: rand(ewaTotal),
    avg: zar(advances.length ? Math.round(ewaTotal / advances.length) : 0),
    avgRaw: advances.length ? rand(Math.round(ewaTotal / advances.length)) : 0,
    perClient: ewaClients ? Number((advances.length / ewaClients).toFixed(1)) : 0,
    trend: ewaMonths.map((key) => Math.round(rand(ewaByMonth.get(key) ?? 0) / 1_000)),
    trendLabels: ewaMonths.map(monthLabel),
  };

  const savingByMonth = new Map<string, number>();
  for (const journey of cumulativeCompleted as any[]) {
    if (!journey.completedAt || !journey.monthlySavingCents) continue;
    const key = monthKey(journey.completedAt);
    savingByMonth.set(key, (savingByMonth.get(key) ?? 0) + journey.monthlySavingCents);
  }
  let cumulative = 0;
  const rangeMonth = filter.rangeStart ? monthKey(filter.rangeStart) : null;
  const savingsPairs = [...savingByMonth.keys()].sort().map((key) => {
    cumulative += savingByMonth.get(key) ?? 0;
    return { key, value: Math.round(rand(cumulative) / 1_000) };
  }).filter((point) => !rangeMonth || point.key >= rangeMonth).slice(-12);
  const savings = savingsPairs.map((point) => point.value);
  const savingsLabels = savingsPairs.map((point) => monthLabel(point.key));

  // Last-12-months trend + period-over-period delta for the four headline KPI
  // cards. Computed directly from the underlying records (as-of each month's
  // end) rather than depending on a persisted ScoreSnapshot existing for
  // every past month, the same way the savings/EWA trends above work — so the
  // most recent trend point always agrees with the headline number.
  const currentMonthKey = monthKey(filter.asAt);
  const trendMonths: string[] = [];
  {
    const [ty, tm] = currentMonthKey.split("-").map(Number);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
      trendMonths.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }
  }
  const firstActivatedAt = new Map<string, Date>();
  for (const journey of liveJourneys as any[]) {
    const existing = firstActivatedAt.get(journey.platformUserId);
    if (!existing || journey.startedAt < existing) firstActivatedAt.set(journey.platformUserId, journey.startedAt);
  }
  let monthlySavingCum = 0;
  for (const [key, value] of savingByMonth.entries()) if (key < trendMonths[0]) monthlySavingCum += value;
  const takeUpTrend: number[] = [];
  const activatedTrend: number[] = [];
  const avgRatingTrend: number[] = [];
  const monthlySavingTrend: number[] = [];
  for (const month of trendMonths) {
    const cutoff = month === currentMonthKey ? filter.asAt : endOfMonth(month);
    takeUpTrend.push(pct(platformUsers.filter((u: any) => u.enrolledAt <= cutoff).length));
    activatedTrend.push(pct([...firstActivatedAt.values()].filter((d) => d <= cutoff).length));
    const ratingsToDate = (ratingsAll as any[]).filter((r: any) => r.createdAt <= cutoff);
    avgRatingTrend.push(ratingsToDate.length ? Number((ratingsToDate.reduce((sum: number, r: any) => sum + r.stars, 0) / ratingsToDate.length).toFixed(1)) : 0);
    monthlySavingCum += savingByMonth.get(month) ?? 0;
    monthlySavingTrend.push(rand(monthlySavingCum));
  }
  // "vs last period" delta — the difference between the last two trend
  // points, so it's always consistent with the trend line drawn next to it.
  const trendDelta = (trend: number[]) => (trend.length >= 2 ? Number((trend[trend.length - 1] - trend[trend.length - 2]).toFixed(1)) : null);

  // Same idea for each "Financial problems resolved" outcome type: a real
  // last-12-months completion count and period-over-period change, replacing
  // what used to be entirely made-up numbers in the drill-down dialog.
  const outcomeMonthly = new Map<string, Map<string, number>>();
  for (const journey of cumulativeCompleted as any[]) {
    if (!journey.completedAt) continue;
    const byMonth = outcomeMonthly.get(journey.type) ?? new Map<string, number>();
    const mk = monthKey(journey.completedAt);
    byMonth.set(mk, (byMonth.get(mk) ?? 0) + 1);
    outcomeMonthly.set(journey.type, byMonth);
  }
  for (const [i, type] of [...byType.keys()].entries()) {
    const byMonth = outcomeMonthly.get(type) ?? new Map<string, number>();
    (outcomes[i] as any).trend = trendMonths.map((m) => byMonth.get(m) ?? 0);
    (outcomes[i] as any).delta = trendDelta((outcomes[i] as any).trend);
  }

  const regions: any[] = [];
  const stressMap: any[] = [];
  const siteStats: any[] = [];
  // Dimension members are independent of the selected cohort. This prevents
  // the region slicer from becoming a one-option control (e.g. "Absa") simply
  // because the current as-at period has no eligible rows for other sites.
  const [allSiteRows, historicalSiteRows] = await Promise.all([
    prisma.site.findMany({
      where: { employerId },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
    prisma.employeeVersion.findMany({
      where: { employee: { employerId }, siteName: { not: null } },
      select: { siteName: true },
      distinct: ["siteName"],
      orderBy: { siteName: "asc" },
    }),
  ]);
  const sites = [...new Set([
    ...allSiteRows.map((row: any) => row.name),
    ...historicalSiteRows.map((row: any) => row.siteName),
    ...eligibleEmployees.map((employee: any) => employee.site?.name),
  ].filter(Boolean))].sort();
  for (const siteName of sites) {
    if (filter.site && filter.site !== siteName) continue;
    const siteEmployees = eligibleEmployees.filter((employee: any) => employee.site?.name === siteName && (!filter.income || employee.incomeBand === filter.income));
    const siteUserIds = new Set(siteEmployees.map((employee: any) => employee.platformUser?.id).filter(Boolean));
    const siteUsers = platformUsers.filter((user: any) => siteUserIds.has(user.id));
    if (!siteEmployees.length) continue;
    const siteDebts = arrearsDebts.filter((debt: any) => siteUserIds.has(debt.platformUserId));
    const siteArrearsUsers = new Set(siteDebts.map((debt: any) => debt.platformUserId)).size;
    const averageDebt = siteDebts.length ? siteDebts.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0) / siteDebts.length : 0;
    const arrearsRate = siteUsers.length ? siteArrearsUsers / siteUsers.length : 0;
    const stress = Math.round(Math.min(100, arrearsRate * 70 + Math.min(30, rand(averageDebt) / 40_000 * 30)));
    const engagement = Math.round(siteUsers.length / siteEmployees.length * 100);
    regions.push({ name: siteName, pct: engagement, stress, indebted: zar(Math.round(averageDebt)) });
    siteStats.push({ name: siteName, stress, engagement, averageDebt });
  }
  regions.sort((a, b) => b.stress - a.stress);
  if (siteStats.length) {
    const byStress = [...siteStats].sort((a, b) => b.stress - a.stress);
    const byEngagement = [...siteStats].sort((a, b) => b.engagement - a.engagement);
    const byDebt = [...siteStats].sort((a, b) => b.averageDebt - a.averageDebt);
    stressMap.push({ l: "Highest stress site", v: byStress[0].name, d: `index ${byStress[0].stress} · avg debt ${zar(Math.round(byStress[0].averageDebt))}`, tone: "red" });
    const lowestStress = byStress[byStress.length - 1];
    stressMap.push({ l: "Lowest stress site", v: lowestStress.name, d: `index ${lowestStress.stress} · most resilient`, tone: "green" });
    stressMap.push({ l: "Most engaged site", v: byEngagement[0].name, d: `${byEngagement[0].engagement}% enrolled`, tone: "blue" });
    stressMap.push({ l: "Most indebted site", v: byDebt[0].name, d: `${zar(Math.round(byDebt[0].averageDebt))} avg unsecured debt`, tone: "amber" });
  }

  const duplicateCreditLife = countPolicy("CREDIT_LIFE");
  const duplicateFuneral = countPolicy("FUNERAL");
  const overShortTerm = countPolicy("SHORT_TERM");
  const riskSignals = [
    { sig: "Paying duplicate credit life", n: duplicateCreditLife, sev: "high", note: "insurance on loans they could replace cheaper" },
    { sig: "Excessive / duplicate funeral cover", n: duplicateFuneral, sev: "high", note: "overlapping or over-priced policies" },
    { sig: "Unsecured arrears", n: arrearsUserIds.size, sev: "high", note: "behind on one or more accounts" },
    { sig: "Possible prescribed debt", n: challengeRows.length, sev: "med", note: "old debt that may no longer be owed" },
    { sig: "Over-insured short-term", n: overShortTerm, sev: "low", note: "paying more than cover requires" },
  ].filter((signal) => signal.n > 0);

  const unresolvedPolicies = policies.filter((policy: any) => policy.isWasteful && !policy.isResolved);
  const unresolvedPremium = unresolvedPolicies.reduce((sum: number, policy: any) => sum + policy.premiumCents, 0);
  // Do not apply an assumed savings percentage. This is the directly observed
  // unresolved premium under review; any realised saving comes from journey outcomes.
  const estimatedMonthlyOpportunity = unresolvedPremium;
  const prescribableBalance = prescribable.reduce((sum: number, debt: any) => sum + debt.balanceCents, 0);
  const opportunities = {
    cards: [
      { name: "Credit life replacement", eligible: countPolicy("CREDIT_LIFE", true), saving: "see audit", icon: "shield" },
      { name: "Funeral consolidation", eligible: countPolicy("FUNERAL", true), saving: "see audit", icon: "umbrella" },
      { name: "Short-term insurance audit", eligible: countPolicy("SHORT_TERM", true), saving: "see audit", icon: "car" },
      { name: "Prescription review", eligible: prescribable.length, saving: "—", extra: `${zarM(prescribableBalance)} challengeable`, icon: "scroll" },
    ].filter((card) => card.eligible > 0),
    estMonthly: zar(estimatedMonthlyOpportunity),
    estAnnual: zar(estimatedMonthlyOpportunity * 12),
    valueLabel: "Unresolved premium under review",
    valueNote: "Observed premium only; no assumed savings percentage is applied.",
  };

  let priorScore: number | null = null;
  if (!skipPrior && score.complete) {
    // Always compare against the most recent *real, comparable* scored period.
    // This is deliberately calculated from source data rather than relying on
    // a snapshot row existing, because historical snapshots can be missing or
    // pre-date the corrected score engine. Site/income slicers are carried into
    // the comparison so the two scores represent the same cohort.
    const cohort = { site: filter.site ?? undefined, income: filter.income ?? undefined };
    let seed: string;
    if (filter.period) {
      seed = previousPeriod(filter.period);
    } else if (filter.quarter) {
      seed = previousQuarterClosePeriod(filter.quarter);
    } else if (filter.range === "quarter") {
      seed = previousQuarterClosePeriod(quarterOf(filter.asAt));
    } else if (filter.range === "30d" && filter.rangeStart) {
      // A 30-day selection must compare against the immediately preceding
      // 30-day window, not against an arbitrary calendar month. Anchor the
      // score engine at the day before the selected window begins.
      const priorEnd = new Date(filter.rangeStart.getTime() - DAY_MS);
      const priorPayload: any = await buildDashboardPayload(
        employerId,
        { range: "30d", asAt: priorEnd.toISOString(), ...cohort },
        true,
      );
      if (priorPayload?.wellness?.complete && priorPayload?.wellness?.score != null) {
        priorScore = Number(priorPayload.wellness.score);
      }
      seed = monthKey(priorEnd);
    } else {
      seed = previousPeriod(monthKey(filter.asAt));
    }

    // Walk backwards until we find a complete score. This prevents a false
    // "No prior period" when the immediately preceding month/quarter has a
    // gap in one source feed but an earlier valid period is available.
    const [sy, sm] = seed.split("-").map(Number);
    for (let offset = 0; offset < 25 && priorScore == null; offset++) {
      const d = new Date(Date.UTC(sy, sm - 1 - offset, 1));
      const candidate = monthKey(d);
      // Prefer a corrected snapshot when one exists, but never require a
      // snapshot row. A missing snapshot is not evidence that the prior
      // period did not exist. If no usable snapshot exists, calculate the
      // score from the dated source records using the same slicers.
      const priorSnap = await prisma.scoreSnapshot.findFirst({
        where: { employerId, period: candidate, payloadVersion: { gte: 4 } },
        select: { optimiseScore: true },
      });
      if (priorSnap?.optimiseScore != null && !filter.site && !filter.income) {
        priorScore = Number(priorSnap.optimiseScore);
        break;
      }
      const priorPayload: any = await buildDashboardPayload(
        employerId,
        { period: candidate, ...cohort },
        true,
      );
      if (priorPayload?.wellness?.complete && priorPayload?.wellness?.score != null) {
        priorScore = Number(priorPayload.wellness.score);
      }
    }
  }

  const sectionAvailability = {
    workforce: headcountDataAvailable,
    enrolment: headcountDataAvailable && feedCoverage.platform_users.available,
    journeys: feedCoverage.platform_users.available && feedCoverage.journeys.available,
    debt: feedCoverage.platform_users.available && feedCoverage.debt_accounts.available,
    insurance: feedCoverage.platform_users.available && feedCoverage.policies.available,
    ratings: feedCoverage.ratings.available,
    referrals: feedCoverage.referrals.available,
    ewa: feedCoverage.salary_advances.available,
  };
  const kpiAvailability = {
    takeUp: sectionAvailability.enrolment,
    activated: sectionAvailability.enrolment,
    monthlySaving: sectionAvailability.journeys,
    avgRating: sectionAvailability.ratings,
  };

  const missingFeeds = CORE_FEEDS.filter((feed) => !feedCoverage[feed].available);
  const loadedFeedCount = CORE_FEEDS.length - missingFeeds.length;
  const scoreDriverLabels: Record<keyof DriverAvailability, string> = {
    engagement: "Engagement",
    cashflow: "Cashflow relief",
    debtRisk: "Debt risk",
    insurance: "Insurance efficiency",
  };
  const missingScoreDrivers = score.missingDrivers.map((driver) => scoreDriverLabels[driver]);

  const warnings: string[] = [];
  if (missingFeeds.length) {
    warnings.push(`Integration incomplete: ${loadedFeedCount} of ${CORE_FEEDS.length} core datasets are available. Missing: ${missingFeeds.map((feed) => CORE_FEED_LABELS[feed]).join(", ")}.`);
  }
  if (!score.complete) {
    warnings.push(`The Workforce Financial Wellness Score is unavailable until the required data is present for: ${missingScoreDrivers.join(", ")}.`);
  }
  if (!headcountSnapshot && !filter.site && !filter.income && (feedCoverage.workforce_snapshots.available || feedCoverage.employees.available)) warnings.push("No workforce headcount snapshot existed at the selected as-of date; the employee effective-date count/current cache was used.");
  if (headcountSnapshot && !filter.site && !filter.income && headcountSnapshot.eligibleCount !== eligibleEmployees.length) {
    warnings.push(`The workforce snapshot denominator (${headcountSnapshot.eligibleCount}) does not match the dated employee detail (${eligibleEmployees.length}) at the selected as-of date; cohort and join coverage should be reconciled.`);
  }
  if (workforceState.usedFallback) warnings.push("Some employees used the current workforce projection because no dated workforce observations were available; historical site/income cohorts should be backfilled.");
  if (workforceState.missingAsAtCount > 0) warnings.push(`${workforceState.missingAsAtCount} employee record(s) had dated workforce history but no valid observation at or before the selected as-of date.`);
  if (eligibleEmployees.some((employee: any) => !employee.eligibleFrom)) warnings.push("Some legacy employee records have no eligible_from date; historical workforce cohorts may be incomplete until they are backfilled.");
  if (debtState.usedFallback) warnings.push("Some debt accounts used the current projection because no immutable observation history was available.");
  if (policyState.usedFallback) warnings.push("Some policies used the current projection because no immutable observation history was available.");
  if ((filter.site || filter.income) && (!employeeIds.length || headcount === 0)) warnings.push("The selected cohort has no eligible employees at the as-of date.");

  const sourceDataUpdatedAt = maxDate([
    employer.sourceUpdatedAt,
    headcountSnapshot?.sourceUpdatedAt,
    ...cohortEmployees.map((employee: any) => employee.sourceUpdatedAt),
    ...platformUsers.map((user: any) => user.sourceUpdatedAt),
    ...liveJourneys.map((journey: any) => journey.sourceUpdatedAt),
    ...debts.map((debt: any) => debt.sourceUpdatedAt),
    ...policies.map((policy: any) => policy.sourceUpdatedAt),
    ...ratings.map((rating: any) => rating.sourceUpdatedAt),
    ...chats.map((chat: any) => chat.sourceUpdatedAt),
    ...referrals.map((referral: any) => referral.sourceUpdatedAt),
    ...advances.map((advance: any) => advance.sourceUpdatedAt),
  ]);
  const averagePerActive = activated ? Math.round(cumulativeMonthlySaving / activated) : 0;
  const arrearsRate = sectionAvailability.debt && debtVisibleUserIds.size
    ? Math.round(arrearsUserIds.size / debtVisibleUserIds.size * 100)
    : null;
  const averageArrearsAccount = arrearsDebts.length ? arrearsTotal / arrearsDebts.length : 0;
  const stressIndex = arrearsRate == null
    ? null
    : Math.round(Math.min(100, (arrearsRate / 100) * 70 + Math.min(30, rand(averageArrearsAccount) / 40_000 * 30)));

  return {
    employer: employer.name,
    headcount,
    dataAsOf: filter.asAt.toISOString(),
    sourceDataUpdatedAt: sourceDataUpdatedAt?.toISOString() ?? null,
    filterContext: {
      period: filter.period,
      range: filter.range,
      label: filter.label,
      rangeStart: filter.rangeStart?.toISOString() ?? null,
      rangeEnd: filter.rangeEnd.toISOString(),
      asAt: filter.asAt.toISOString(),
      site: filter.site,
      income: filter.income,
      incomeLabel: filter.income ? INCOME_LABEL[filter.income] : null,
      semantics: {
        stock: "Headcount, funnel, wellness, debt and insurance are measured as at the range end.",
        flow: "Outcomes, ratings, chat, referrals and wage advances are measured inside the selected range.",
      },
    },
    filterOptions: {
      // Filter choices must describe the employer's full available dimension,
      // not only the currently eligible/as-at cohort. Otherwise a historical
      // period or an admin employer switch can make a valid region disappear.
      sites: sites.map((site) => ({ value: site, label: site })),
      regions: sites.map((site) => ({ value: site, label: site })),
      incomes: INCOME_VALUES.map((value) => ({ value, label: INCOME_LABEL[value] })),
    },
    dataQuality: {
      warnings,
      loadedFeedCount,
      coreFeedCount: CORE_FEEDS.length,
      missingFeeds: missingFeeds.map((feed) => ({ key: feed, label: CORE_FEED_LABELS[feed] })),
      feedCoverage,
      scoreReady: score.complete,
      missingScoreDrivers,
      headcountSource: filter.site || filter.income ? "effective employee rows" : headcountSnapshot ? `snapshot ${headcountSnapshot.asOfDate.toISOString().slice(0, 10)}` : eligibleEmployees.length ? "effective employee rows" : "employer current cache",
      workforceObservationRows: workforceState.versionCount,
      workforceProjectionFallback: workforceState.usedFallback,
      workforceMissingAtAsOf: workforceState.missingAsAtCount,
      debtObservationRows: debtState.versionCount,
      policyObservationRows: policyState.versionCount,
    },
    availability: sectionAvailability,
    portfolio: {
      takeUp: sectionAvailability.enrolment ? pct(enrolled) : null,
      engaged: sectionAvailability.enrolment ? pct(activated) : null,
      wellness: score.optimiseScore,
      saving: sectionAvailability.journeys ? rand(cumulativeMonthlySaving) : null,
      betterOff: sectionAvailability.journeys ? completedFix : null,
      oppValue: sectionAvailability.insurance ? rand(estimatedMonthlyOpportunity) : null,
      stress: stressIndex,
      arrears: arrearsRate,
      rating: sectionAvailability.ratings ? Number(avgRating.toFixed(1)) : null,
      fiveStarPct: sectionAvailability.ratings ? fiveStarPct : null,
    },
    exec: { items: [
      { v: sectionAvailability.enrolment ? enrolled.toLocaleString("en-ZA") : "—", l: "employees enrolled", available: sectionAvailability.enrolment },
      { v: sectionAvailability.journeys ? zar(cumulativeMonthlySaving) : "—", l: "monthly cashflow restored", available: sectionAvailability.journeys },
      { v: sectionAvailability.debt ? zar(active.rand) : "—", l: "debt under active intervention", available: sectionAvailability.debt },
      { v: sectionAvailability.debt ? String(challengeRows.length) : "—", l: "prescribed debts challenged", available: sectionAvailability.debt },
      { v: sectionAvailability.journeys ? completedFix.toLocaleString("en-ZA") : "—", l: "employees better off", available: sectionAvailability.journeys },
      { v: sectionAvailability.ratings ? `${avgRating.toFixed(1)}/5` : "—", l: "employee satisfaction", available: sectionAvailability.ratings },
    ] },
    wellness: {
      score: score.optimiseScore,
      prior: priorScore,
      band: wellnessBand(score.optimiseScore),
      complete: score.complete,
      missingDrivers: missingScoreDrivers,
      drivers: [
        { name: "Engagement", score: score.sub.engagement, available: score.sub.engagement != null, weight: weights.ENGAGEMENT, note: "started a journey vs. eligible" },
        { name: "Cashflow relief", score: score.sub.cashflow, available: score.sub.cashflow != null, weight: weights.CASHFLOW, note: "savings unlocked vs. potential" },
        { name: "Debt risk", score: score.sub.debtRisk, available: score.sub.debtRisk != null, weight: weights.DEBT_RISK, note: "users in arrears (lower = riskier)" },
        { name: "Insurance efficiency", score: score.sub.insurance, available: score.sub.insurance != null, weight: weights.INSURANCE, note: "wasteful cover resolved" },
      ],
    },
    debtStates: {
      available: sectionAvailability.debt,
      active: { rand: rand(active.rand), employees: active.employees, label: "Under active intervention", note: "settlement or reduced-instalment arrangements sent" },
      challenged: { rand: rand(challenged.rand), employees: challenged.employees, label: "Being challenged", note: "potentially prescribed debt contested" },
      guided: { rand: rand(guided.rand), employees: guided.employees, label: "Self-managed via guidance", note: "educated on prescription where no arrangement was affordable" },
    },
    kpis: {
      takeUp: { pct: kpiAvailability.takeUp ? pct(enrolled) : null, enrolled: kpiAvailability.takeUp ? enrolled : null, available: kpiAvailability.takeUp, trend: kpiAvailability.takeUp ? takeUpTrend : [], delta: kpiAvailability.takeUp ? trendDelta(takeUpTrend) : null },
      activated: { pct: kpiAvailability.activated ? pct(activated) : null, count: kpiAvailability.activated ? activated : null, available: kpiAvailability.activated, trend: kpiAvailability.activated ? activatedTrend : [], delta: kpiAvailability.activated ? trendDelta(activatedTrend) : null },
      monthlySaving: { rand: kpiAvailability.monthlySaving ? rand(cumulativeMonthlySaving) : null, perHead: kpiAvailability.monthlySaving ? rand(averagePerActive) : null, available: kpiAvailability.monthlySaving, trend: kpiAvailability.monthlySaving ? monthlySavingTrend : [], delta: kpiAvailability.monthlySaving ? trendDelta(monthlySavingTrend) : null },
      avgRating: { val: kpiAvailability.avgRating ? Number(avgRating.toFixed(1)) : null, responses: kpiAvailability.avgRating ? ratingResponses : null, available: kpiAvailability.avgRating, trend: kpiAvailability.avgRating ? avgRatingTrend : [], delta: kpiAvailability.avgRating ? trendDelta(avgRatingTrend) : null },
    },
    funnel: [
      { label: "Eligible workforce", sub: "as at range end", n: headcountDataAvailable ? headcount : null, pct: headcountDataAvailable ? 100 : null, available: headcountDataAvailable },
      { label: "Enrolled", sub: "joined by range end", n: sectionAvailability.enrolment ? enrolled : null, pct: sectionAvailability.enrolment ? pct(enrolled) : null, available: sectionAvailability.enrolment },
      { label: "Activated", sub: "started a fix by range end", n: sectionAvailability.enrolment ? activated : null, pct: sectionAvailability.enrolment ? pct(activated) : null, available: sectionAvailability.enrolment },
      { label: "Completed a fix", sub: "at least one resolved by range end", n: sectionAvailability.journeys ? completedFix : null, pct: sectionAvailability.journeys ? pct(completedFix) : null, available: sectionAvailability.journeys },
      { label: "Multiple fixes", sub: "two or more resolved by range end", n: sectionAvailability.journeys ? multipleFix : null, pct: sectionAvailability.journeys ? pct(multipleFix) : null, available: sectionAvailability.journeys },
    ],
    outcomes,
    valueStrip: [
      { l: "Monthly cash freed up", v: sectionAvailability.journeys ? zar(cumulativeMonthlySaving) : "—", d: sectionAvailability.journeys ? `${zar(cumulativeMonthlySaving * 12)} annualised` : "Journey data not loaded", available: sectionAvailability.journeys },
      { l: "New monthly savings in range", v: sectionAvailability.journeys ? zar(flowMonthlySaving) : "—", d: sectionAvailability.journeys ? filter.label : "Journey data not loaded", available: sectionAvailability.journeys },
      { l: "Prescribed debt challenged", v: sectionAvailability.debt ? zarM(challengedBalance) : "—", d: sectionAvailability.debt ? `${challengeRows.length} accounts as at end` : "Debt data not loaded", available: sectionAvailability.debt },
      { l: "Arrears under active intervention", v: sectionAvailability.debt ? zar(active.rand) : "—", d: sectionAvailability.debt ? `${active.employees} employees as at end` : "Debt data not loaded", available: sectionAvailability.debt },
    ],
    debtProfile,
    creditors,
    creditorsTotal,
    income,
    savings,
    savingsLabels,
    stressMap,
    regions,
    referral: { ...referral, available: sectionAvailability.referrals },
    ewa: { ...ewa, available: sectionAvailability.ewa },
    riskSignals,
    opportunities,
    ratings: { avg: sectionAvailability.ratings ? Number(avgRating.toFixed(1)) : null, dist: ratingPct, fiveStarPct: sectionAvailability.ratings ? fiveStarPct : null, nps: sectionAvailability.ratings ? nps : null, responses: sectionAvailability.ratings ? ratingResponses : null, available: sectionAvailability.ratings },
    prescription: {
      available: sectionAvailability.debt,
      total: zarM(challengedBalance),
      accounts: challengeRows.length,
      avgPerAccount: challengeRows.length ? zar(Math.round(challengedBalance / challengeRows.length)) : "R 0",
      statusBars: [
        { l: "Identified", n: stageCount("IDENTIFIED"), pct: challengeRows.length ? 100 : 0, c: "#bfe0f5" },
        { l: "Letter dispatched", n: stageCount("LETTER_SENT"), pct: challengeRows.length ? Math.round(stageCount("LETTER_SENT") / challengeRows.length * 100) : 0, c: "#4ea3da" },
        { l: "Creditor conceded", n: stageCount("CREDITOR_CONCEDED"), pct: challengeRows.length ? Math.round(stageCount("CREDITOR_CONCEDED") / challengeRows.length * 100) : 0, c: "#0078c7" },
        { l: "Written off", n: stageCount("WRITTEN_OFF"), pct: challengeRows.length ? Math.round(stageCount("WRITTEN_OFF") / challengeRows.length * 100) : 0, c: "#1fa463" },
      ],
      writtenOff: zarM(writtenOffBalance),
    },
    chat: {
      // Chat is supplied by a separate integration, not the 10 core source feeds.
      // Until that source has supplied records, the UI must show it as unavailable
      // rather than presenting confirmed zeroes.
      available: (chatsAll as any[]).length > 0,
      conversations: chatTotal,
      resolvedInChat: chatTotal ? Math.round(chatResolved / chatTotal * 100) : 0,
      escalated: chatTotal ? Math.round((chatTotal - chatResolved) / chatTotal * 100) : 0,
      avgFirstReply: `${medianReply}s`,
      csat: Number(chatCsat.toFixed(1)),
      byJourney: chatByJourney,
      trending: chatTrending,
      volume: chatVolume,
    },
    monthActivity: {
      label: filter.label,
      enrolled: sectionAvailability.enrolment ? platformUsers.filter((user: any) => inWindow(user.enrolledAt, filter)).length : null,
      completed: sectionAvailability.journeys ? flowCompleted.length : null,
      savingUnlocked: sectionAvailability.journeys ? zar(flowMonthlySaving) : null,
      advancesCount: sectionAvailability.ewa ? advances.length : null,
      advancesTotal: sectionAvailability.ewa ? zar(ewaTotal) : null,
    },
  };
}

async function readPersistentDashboardCache(employerId: string, query: DashboardQuery): Promise<any | null> {
  // Persistent cache is only authoritative for explicit dashboard selections.
  // Relative/latest queries depend on the current anchor and are intentionally
  // resolved by the normal builder before being persisted.
  const cacheKey = dashboardCacheKey(employerId, query);
  const row = await prisma.dashboardCohortCache.findUnique({
    where: { employerId_cacheKey: { employerId, cacheKey } },
    select: { payload: true },
  });
  return row?.payload ?? null;
}

async function persistDashboardCache(employerId: string, query: DashboardQuery, payload: any): Promise<void> {
  const cacheKey = dashboardCacheKey(employerId, query);
  const period = query.period ?? null;
  const asAt = payload?.filterContext?.asAt ? new Date(payload.filterContext.asAt) : (query.asAt ? new Date(query.asAt) : null);
  await prisma.dashboardCohortCache.upsert({
    where: { employerId_cacheKey: { employerId, cacheKey } },
    create: {
      employerId, cacheKey, period, range: query.range ?? null, site: query.site ?? null,
      income: query.income ?? null, asAt: asAt && !Number.isNaN(asAt.getTime()) ? asAt : null,
      optimiseScore: payload?.wellness?.score == null ? null : Number(payload.wellness.score),
      payload,
    },
    update: {
      period, range: query.range ?? null, site: query.site ?? null, income: query.income ?? null,
      asAt: asAt && !Number.isNaN(asAt.getTime()) ? asAt : null,
      optimiseScore: payload?.wellness?.score == null ? null : Number(payload.wellness.score),
      payload, computedAt: new Date(),
    },
  });
}

export async function getDashboardPayload(employerId: string, query: DashboardQuery = {}) {
  // Resolve "latest" to the newest persisted monthly snapshot before cache
  // lookup. This makes the default landing page use the same fast read-model
  // path as an explicit month instead of rebuilding 100k-row source data.
  if (!query.period && !query.quarter && query.range === "latest") {
    const latest = await prisma.scoreSnapshot.findFirst({
      where: { employerId, payloadVersion: { gte: 4 } },
      orderBy: { period: "desc" },
      select: { period: true },
    });
    if (latest?.period) query = { ...query, period: latest.period, range: undefined };
  }
  const key = dashboardCacheKey(employerId, query);
  const hit = dashboardCache.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.payload;

  // Exact month/cohort reads are the hot path for slicers. Resolve from the
  // persistent read model before touching Employee/Journey/Debt/Policy rows.
  // This is what turns a 100k-row dashboard interaction into a tiny indexed
  // PostgreSQL lookup.
  if (query.period && query.range == null) {
    const persisted = await readPersistentDashboardCache(employerId, query);
    if (persisted) {
      dashboardCache.set(key, { expiresAt: now + DASHBOARD_CACHE_TTL_MS, payload: persisted });
      return persisted;
    }
  }

  const payload = await buildDashboardPayload(employerId, query);
  dashboardCache.set(key, { expiresAt: now + DASHBOARD_CACHE_TTL_MS, payload });
  // Persist every explicit period/cohort result. A cold cohort pays the
  // calculation cost once; every subsequent user sees the read-model path.
  if (query.period && query.range == null) {
    try { await persistDashboardCache(employerId, query, payload); } catch { /* cache failure must never break dashboard */ }
  }
  if (dashboardCache.size > 250) {
    for (const [k, v] of dashboardCache) if (v.expiresAt <= now) dashboardCache.delete(k);
  }
  return payload;
}

async function persistScoreSnapshot(employerId: string, period: string, payload: any): Promise<boolean> {
  if (!payload?.wellness?.complete || payload?.wellness?.score == null) return false;
  const weights: Weights = {
    ENGAGEMENT: payload.wellness.drivers[0].weight,
    CASHFLOW: payload.wellness.drivers[1].weight,
    DEBT_RISK: payload.wellness.drivers[2].weight,
    INSURANCE: payload.wellness.drivers[3].weight,
  };
  const sub = {
    engagement: payload.wellness.drivers[0].score,
    cashflow: payload.wellness.drivers[1].score,
    debtRisk: payload.wellness.drivers[2].score,
    insurance: payload.wellness.drivers[3].score,
  };
  const rawScore = Number((
    sub.engagement * weights.ENGAGEMENT
    + sub.cashflow * weights.CASHFLOW
    + sub.debtRisk * weights.DEBT_RISK
    + sub.insurance * weights.INSURANCE
  ).toFixed(2));
  const rangeStart = new Date(payload.filterContext.rangeStart ?? startOfMonth(period));
  const rangeEnd = new Date(payload.filterContext.rangeEnd ?? endOfMonth(period));
  const asAt = new Date(payload.filterContext.asAt ?? rangeEnd);
  const snapshotData = {
    rangeStart,
    rangeEnd,
    asAt,
    // Bumped 3 -> 4: the cashflow driver's "savings achievable" used to
    // silently fall back to the unlocked amount itself whenever no
    // AchievableTarget row existed (which was always, since nothing wrote
    // to that table) — pinning every Cashflow sub-score, and therefore
    // every Optimise Score, at 100. Snapshots written before this fix are
    // no longer trustworthy; gating on payloadVersion >= 4 hides them from
    // the period picker / score history / "vs last period" delta until
    // they're recomputed (see scripts/rebuild-score-snapshots.ts).
    payloadVersion: 4,
    optimiseScore: payload.wellness.score,
    rawScore,
    engagementScore: sub.engagement,
    cashflowScore: sub.cashflow,
    debtRiskScore: sub.debtRisk,
    insuranceScore: sub.insurance,
    engagementWeight: weights.ENGAGEMENT,
    cashflowWeight: weights.CASHFLOW,
    debtRiskWeight: weights.DEBT_RISK,
    insuranceWeight: weights.INSURANCE,
    payload,
  };
  await prisma.scoreSnapshot.upsert({
    where: { employerId_period: { employerId, period } },
    create: { employerId, period, ...snapshotData },
    update: { ...snapshotData, computedAt: new Date() },
  });
  return true;
}

async function warmDashboardCohorts(employerId: string, periods: string[]): Promise<void> {
  const employees = await prisma.employee.findMany({
    where: { employerId, sourceDeletedAt: null },
    select: { incomeBand: true, site: { select: { name: true } } },
  });
  const sites = [...new Set(employees.map((e: any) => e.site?.name).filter(Boolean))] as string[];
  const incomes = [...new Set(employees.map((e: any) => e.incomeBand).filter(Boolean))] as string[];
  const queries: DashboardQuery[] = [];
  // Warm the combinations users can actually select. Keep concurrency low so
  // Railway Hobby is not flooded with hundreds of simultaneous heavy queries.
  for (const period of periods) {
    for (const site of sites) queries.push({ period, site });
    for (const income of incomes) queries.push({ period, income });
    for (const site of sites) for (const income of incomes) queries.push({ period, site, income });
  }
  for (let i = 0; i < queries.length; i += 2) {
    await Promise.all(queries.slice(i, i + 2).map(async (query) => {
      try { await getDashboardPayload(employerId, query); } catch { /* incomplete cohort stays cold */ }
    }));
  }
}

export async function snapshotEmployer(employerId: string, period: string = currentPeriod()) {
  if (!isValidPeriod(period) || period > currentPeriod()) throw new Error(`invalid or future period: ${period}`);
  // Imported data invalidates the persistent read model. The next snapshot
  // rebuilds it from the authoritative source tables.
  await prisma.dashboardCohortCache.deleteMany({ where: { employerId } });
  for (const k of [...dashboardCache.keys()]) if (k.startsWith(`[\"${employerId}\"`)) dashboardCache.delete(k);
  const payload: any = await buildDashboardPayload(employerId, { period });
  const persisted = await persistScoreSnapshot(employerId, period, payload);
  if (persisted) {
    await buildMonthlySnapshots(employerId, currentPeriod());
    const periods = await monthsWithData(employerId);
    // Warm historical monthly cohorts after the authoritative snapshots exist.
    // This work is intentionally outside the interactive request path.
    await warmDashboardCohorts(employerId, periods);
  }
  return { ok: true, persisted, period, asAt: payload.filterContext.asAt, scoreReady: payload.wellness.complete };
}

async function monthsWithData(employerId: string): Promise<string[]> {
  const employees: any[] = await prisma.employee.findMany({ where: { employerId }, select: { id: true, platformUser: { select: { id: true } } } });
  const employeeIds = employees.map((employee: any) => employee.id);
  const platformUserIds = employees.map((employee: any) => employee.platformUser?.id).filter((id: string | undefined): id is string => !!id);
  const [workforceVersions, users, journeys, ratings, chats, referrals, advances, headcounts, debtVersions, policyVersions] = await Promise.all([
    employeeIds.length ? prisma.employeeVersion.findMany({ where: { employeeId: { in: employeeIds } }, select: { observedAt: true, eligibleFrom: true, eligibleTo: true } }) : [],
    platformUserIds.length ? prisma.platformUser.findMany({ where: { id: { in: platformUserIds } }, select: { enrolledAt: true, activatedAt: true } }) : [],
    platformUserIds.length ? prisma.journey.findMany({ where: { platformUserId: { in: platformUserIds } }, select: { startedAt: true, completedAt: true } }) : [],
    platformUserIds.length ? prisma.rating.findMany({ where: { platformUserId: { in: platformUserIds } }, select: { createdAt: true } }) : [],
    employeeIds.length ? prisma.chatSession.findMany({ where: { employerId, employeeId: { in: employeeIds } }, select: { startedAt: true } }) : [],
    platformUserIds.length ? prisma.referral.findMany({ where: { platformUserId: { in: platformUserIds } }, select: { sharedAt: true, convertedAt: true } }) : [],
    employeeIds.length ? prisma.salaryAdvance.findMany({ where: { employerId, employeeId: { in: employeeIds } }, select: { advancedAt: true } }) : [],
    prisma.employerHeadcountSnapshot.findMany({ where: { employerId }, select: { asOfDate: true } }),
    platformUserIds.length ? prisma.debtAccountVersion.findMany({ where: { account: { platformUserId: { in: platformUserIds } } }, select: { observedAt: true } }) : [],
    platformUserIds.length ? prisma.insurancePolicyVersion.findMany({ where: { policy: { platformUserId: { in: platformUserIds } } }, select: { observedAt: true } }) : [],
  ]);
  const months = new Set<string>();
  const add = (date: Date | null | undefined) => { if (date) months.add(monthKey(date)); };
  for (const workforce of workforceVersions as any[]) { add(workforce.observedAt); add(workforce.eligibleFrom); add(workforce.eligibleTo); }
  for (const user of users as any[]) { add(user.enrolledAt); add(user.activatedAt); }
  for (const journey of journeys as any[]) { add(journey.startedAt); add(journey.completedAt); }
  for (const rating of ratings as any[]) add(rating.createdAt);
  for (const chat of chats as any[]) add(chat.startedAt);
  for (const referral of referrals as any[]) { add(referral.sharedAt); add(referral.convertedAt); }
  for (const advance of advances as any[]) add(advance.advancedAt);
  for (const headcount of headcounts as any[]) add(headcount.asOfDate);
  for (const debt of debtVersions as any[]) add(debt.observedAt);
  for (const policy of policyVersions as any[]) add(policy.observedAt);
  return [...months].sort();
}

export async function buildMonthlySnapshots(employerId: string, currentP: string = currentPeriod()) {
  const months = await monthsWithData(employerId);
  for (const period of months) {
    if (period >= currentP) continue;
    const payload: any = await buildDashboardPayload(employerId, { period });
    await persistScoreSnapshot(employerId, period, payload);
  }
}

export { prisma };
