// ════════════════════════════════════════════════════════════════════
//  FINANCIAL WELLNESS SCORE ENGINE
//
//  A score is only reportable when the source data needed for every
//  weighted driver is available. Missing feeds are represented as null,
//  never as a synthetic zero or perfect score.
// ════════════════════════════════════════════════════════════════════
export const DEFAULT_WEIGHTS = {
    ENGAGEMENT: 0.2,
    CASHFLOW: 0.3,
    DEBT_RISK: 0.3,
    INSURANCE: 0.2,
};
const clamp = (n) => Math.max(0, Math.min(100, n));
const ratio = (num, den) => (den <= 0 ? 0 : (num / den) * 100);
const ALL_AVAILABLE = {
    engagement: true,
    cashflow: true,
    debtRisk: true,
    insurance: true,
};
export function computeSubScores(i) {
    const insurance = i.wastefulCoverFound <= 0 && (i.policiesObserved ?? 0) > 0
        ? 100
        : ratio(i.wastefulCoverFixed, i.wastefulCoverFound);
    return {
        engagement: Math.round(clamp(ratio(i.usersStartedJourney, i.eligibleEmployees))),
        cashflow: Math.round(clamp(ratio(i.savingsUnlocked, i.savingsAchievable))),
        debtRisk: Math.round(clamp(i.platformUsers <= 0
            ? 0
            : 100 - (i.platformUsersInArrears / i.platformUsers) * 100)),
        insurance: Math.round(clamp(insurance)),
    };
}
export function computeOptimiseScore(inputs, weights = DEFAULT_WEIGHTS, availability = ALL_AVAILABLE) {
    const sum = weights.ENGAGEMENT + weights.CASHFLOW + weights.DEBT_RISK + weights.INSURANCE;
    if (Math.abs(sum - 1) > 1e-6) {
        throw new Error(`Score weights must sum to 1.0, got ${sum}`);
    }
    const numeric = computeSubScores(inputs);
    const sub = {
        engagement: availability.engagement ? numeric.engagement : null,
        cashflow: availability.cashflow ? numeric.cashflow : null,
        debtRisk: availability.debtRisk ? numeric.debtRisk : null,
        insurance: availability.insurance ? numeric.insurance : null,
    };
    const missingDrivers = Object.keys(availability)
        .filter((key) => !availability[key]);
    const complete = missingDrivers.length === 0;
    if (!complete) {
        return {
            optimiseScore: null,
            rawScore: null,
            sub,
            weights,
            complete,
            missingDrivers,
        };
    }
    const raw = sub.engagement * weights.ENGAGEMENT +
        sub.cashflow * weights.CASHFLOW +
        sub.debtRisk * weights.DEBT_RISK +
        sub.insurance * weights.INSURANCE;
    return {
        optimiseScore: Math.round(raw),
        rawScore: Number(raw.toFixed(2)),
        sub,
        weights,
        complete,
        missingDrivers,
    };
}
