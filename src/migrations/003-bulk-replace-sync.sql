-- ═══════════════════════════════════════════════════════════════════════════
-- ULTRA-FAST BULK REPLACE FOR SQL SYNCS (200k+ rows)
--
-- Strategy: DELETE old sync window + BULK INSERT new data
-- Bypasses all constraint checks. Assumes source data is clean (no dupes).
-- Time: milliseconds for 200k rows instead of seconds/minutes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- Employees: Delete sync window + bulk insert
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_employees_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  -- Delete all rows in the sync window from the destination
  DELETE FROM "Employee"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
  -- Bulk insert from source view. No constraint checks.
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Employers: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_employers_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "Employer"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Platform Users: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_platform_users_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "PlatformUser"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Journeys: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_journeys_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "Journey"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Debt Accounts: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_debt_accounts_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "DebtAccount"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Policies: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_policies_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "Policy"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Ratings: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_ratings_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "Rating"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Referrals: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_referrals_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "Referral"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Salary Advances: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_salary_advances_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "SalaryAdvance"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Workforce Snapshots: Bulk replace
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE sync_workforce_snapshots_bulk(
  p_schema_name TEXT DEFAULT 'public',
  p_view_prefix TEXT DEFAULT 'v_',
  p_since TIMESTAMP DEFAULT NULL,
  p_through TIMESTAMP DEFAULT NOW(),
  OUT p_inserted BIGINT,
  OUT p_deleted BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM "EmployerHeadcountSnapshot"
  WHERE source_updated_at <= p_through
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  v_deleted_count := ROW_COUNT;
  
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
    AND (p_since IS NULL OR source_updated_at > p_since);
  
  p_inserted := ROW_COUNT;
  p_deleted := v_deleted_count;
END;
$$;

