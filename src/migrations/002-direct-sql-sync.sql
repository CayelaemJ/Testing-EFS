-- ═══════════════════════════════════════════════════════════════════════════
-- DIRECT SQL UPSERT FOR SQL SOURCE INTEGRATION
--
-- For SQL-to-SQL integration: Query source views directly and upsert atomically
-- in a single transaction. Zero JSONB parsing, zero row-by-row inserts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- Employers: INSERT ... SELECT ... ON CONFLICT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_employers_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "Employer" (
      "employer_ref", "name", "eligible_count", "eligible_count_as_at",
      "source_updated_at", "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      employer_ref, name, eligible_count, eligible_count_as_at,
      source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_employers
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("employer_ref") DO UPDATE SET
      "name" = EXCLUDED."name",
      "eligible_count" = EXCLUDED."eligible_count",
      "eligible_count_as_at" = EXCLUDED."eligible_count_as_at",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Employees: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_employees_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "Employee" (
      "employer_ref", "payroll_ref", "observed_at", "site_name", "income_band",
      "eligible_from", "eligible_to", "active", "source_updated_at",
      "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      employer_ref, payroll_ref, observed_at, site_name, income_band,
      eligible_from, eligible_to, active, source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_employees
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("employer_ref", "payroll_ref", "observed_at") DO UPDATE SET
      "site_name" = EXCLUDED."site_name",
      "income_band" = EXCLUDED."income_band",
      "eligible_from" = EXCLUDED."eligible_from",
      "eligible_to" = EXCLUDED."eligible_to",
      "active" = EXCLUDED."active",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Journeys: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_journeys_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "Journey" (
      "journey_ref", "employer_ref", "payroll_ref", "type", "status",
      "started_at", "completed_at", "monthly_saving_rand", "balance_impact_rand",
      "source_updated_at", "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      journey_ref, employer_ref, payroll_ref, type, status,
      started_at, completed_at, monthly_saving_rand, balance_impact_rand,
      source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_journeys
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("journey_ref") DO UPDATE SET
      "type" = EXCLUDED."type",
      "status" = EXCLUDED."status",
      "started_at" = EXCLUDED."started_at",
      "completed_at" = EXCLUDED."completed_at",
      "monthly_saving_rand" = EXCLUDED."monthly_saving_rand",
      "balance_impact_rand" = EXCLUDED."balance_impact_rand",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Debt Accounts: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_debt_accounts_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "DebtAccount" (
      "account_ref", "employer_ref", "payroll_ref", "observed_at", "closed_at",
      "creditor_name", "credit_type", "balance_rand", "in_arrears", "state",
      "challenge_status", "journey_ref", "source_updated_at", "source_deleted_at",
      "created_at", "updated_at"
    )
    SELECT
      account_ref, employer_ref, payroll_ref, observed_at, closed_at,
      creditor_name, credit_type, balance_rand, in_arrears, state,
      challenge_status, journey_ref, source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_debt_accounts
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("account_ref") DO UPDATE SET
      "observed_at" = EXCLUDED."observed_at",
      "closed_at" = EXCLUDED."closed_at",
      "balance_rand" = EXCLUDED."balance_rand",
      "in_arrears" = EXCLUDED."in_arrears",
      "state" = EXCLUDED."state",
      "challenge_status" = EXCLUDED."challenge_status",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Policies: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_policies_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "Policy" (
      "policy_ref", "employer_ref", "payroll_ref", "observed_at", "effective_from",
      "effective_to", "resolved_at", "type", "premium_rand", "is_wasteful",
      "is_resolved", "source_updated_at", "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      policy_ref, employer_ref, payroll_ref, observed_at, effective_from,
      effective_to, resolved_at, type, premium_rand, is_wasteful,
      is_resolved, source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_policies
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("policy_ref") DO UPDATE SET
      "observed_at" = EXCLUDED."observed_at",
      "effective_from" = EXCLUDED."effective_from",
      "effective_to" = EXCLUDED."effective_to",
      "resolved_at" = EXCLUDED."resolved_at",
      "premium_rand" = EXCLUDED."premium_rand",
      "is_wasteful" = EXCLUDED."is_wasteful",
      "is_resolved" = EXCLUDED."is_resolved",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Ratings: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_ratings_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "Rating" (
      "rating_ref", "employer_ref", "payroll_ref", "journey_type", "stars",
      "created_at", "source_updated_at", "source_deleted_at", "updated_at"
    )
    SELECT
      rating_ref, employer_ref, payroll_ref, journey_type, stars,
      created_at, source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW()
    FROM v_ratings
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("rating_ref") DO UPDATE SET
      "stars" = EXCLUDED."stars",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Referrals: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_referrals_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "Referral" (
      "referral_ref", "employer_ref", "payroll_ref", "channel", "shared_at",
      "converted", "converted_at", "source_updated_at", "source_deleted_at",
      "created_at", "updated_at"
    )
    SELECT
      referral_ref, employer_ref, payroll_ref, channel, shared_at,
      converted, converted_at, source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_referrals
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("referral_ref") DO UPDATE SET
      "shared_at" = EXCLUDED."shared_at",
      "converted" = EXCLUDED."converted",
      "converted_at" = EXCLUDED."converted_at",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Salary Advances: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_salary_advances_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "SalaryAdvance" (
      "salary_advance_id", "employer_ref", "client_id", "payroll_ref", "amount",
      "salary_advance_status", "bank_account_verification_status", "blacklisted",
      "advanced_at", "source_updated_at", "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      salary_advance_id, employer_ref, client_id, payroll_ref, amount,
      salary_advance_status, bank_account_verification_status, blacklisted,
      advanced_at, source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_salary_advances
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("salary_advance_id") DO UPDATE SET
      "amount" = EXCLUDED."amount",
      "salary_advance_status" = EXCLUDED."salary_advance_status",
      "bank_account_verification_status" = EXCLUDED."bank_account_verification_status",
      "blacklisted" = EXCLUDED."blacklisted",
      "advanced_at" = EXCLUDED."advanced_at",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Workforce Snapshots: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_workforce_snapshots_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "EmployerHeadcountSnapshot" (
      "employer_ref", "as_of_date", "eligible_count", "source_updated_at",
      "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      employer_ref, as_of_date, eligible_count, source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_workforce_snapshots
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("employer_ref", "as_of_date") DO UPDATE SET
      "eligible_count" = EXCLUDED."eligible_count",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Platform Users: Direct INSERT ... SELECT
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_platform_users_direct(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_updated BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  WITH upsert AS (
    INSERT INTO "PlatformUser" (
      "employer_ref", "payroll_ref", "enrolled_at", "activated_at",
      "has_credit_profile", "source_updated_at", "source_deleted_at",
      "created_at", "updated_at"
    )
    SELECT
      employer_ref, payroll_ref, enrolled_at, activated_at,
      has_credit_profile, source_updated_at,
      CASE WHEN is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM v_platform_users
    WHERE source_updated_at <= p_through
      AND (p_since IS NULL OR source_updated_at > p_since)
    ON CONFLICT ("employer_ref", "payroll_ref") DO UPDATE SET
      "enrolled_at" = EXCLUDED."enrolled_at",
      "activated_at" = EXCLUDED."activated_at",
      "has_credit_profile" = EXCLUDED."has_credit_profile",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT
  INTO p_inserted, p_updated
  FROM upsert;
END;
$$;

