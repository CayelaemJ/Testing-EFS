# 100k-row performance hardening

## What changed

- Dashboard payloads use a 15-second, cohort-aware in-process cache. Cache keys include employer, period/range, region/site, income band and historical `asAt`.
- Historical workforce resolution now uses PostgreSQL `LEFT JOIN LATERAL` to select the latest `EmployeeVersion` per employee at the requested as-of date. The previous implementation loaded and sorted every historical version in Node.
- Added composite indexes for the dashboard's hot predicates and latest-version lookups.
- The period/month endpoint is snapshot-first. It no longer loads date columns from every large source table and invokes the full dashboard calculation once for every month when unfiltered.
- The persisted `ScoreSnapshot` remains the fast path for company-level month scores; cohort-specific Region/Income month scores are calculated only when those filters are actually selected.

## Database deployment

`npm run db:deploy` runs `prisma db push --skip-generate`, so the new indexes are applied non-destructively.

For PostgreSQL connection pooling, use an appropriate `connection_limit` and `pool_timeout` in `DATABASE_URL` for the Railway service. Do not blindly increase the pool: the limit should account for the database's max connections and the number of application instances.

## Expected architecture at 100k+

The long-term target is a pre-aggregated monthly fact table for dashboard metrics. The live dashboard should read one small row per employer/period/cohort dimension rather than repeatedly scanning raw event history. Raw immutable tables remain the audit/source-of-truth layer.


## v0.5.7 persistent read model

The dashboard now persists exact monthly cohort payloads in `DashboardCohortCache`, keyed by employer + period + range + site + income. Exact monthly requests hit this indexed table before the raw dashboard builder. Snapshot/import processing invalidates and warms selectable cohorts with bounded concurrency. This is intentionally a read-model/cache layer; PostgreSQL remains the application source of truth.

Railway deployment requires no second database for this layer. The schema is applied by the existing `npm run db:deploy` (`prisma db push --skip-generate`) step.
