-- ═══════════════════════════════════════════════════════════════════════════
-- UPSERT STORED PROCEDURES FOR LIVE INTEGRATION SYNCS
-- 
-- These procedures handle the merge logic when pulling from API or SQL sources.
-- Instead of validating/transforming in Node.js, we let PostgreSQL do the work.
-- Dramatically reduces memory usage and round-trip overhead.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- Employers: simple upsert on employer_ref (natural key)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_employers(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'name')::VARCHAR(150) AS name,
      (row->>'eligible_count')::INT AS eligible_count,
      (row->>'eligible_count_as_at')::TIMESTAMP AS eligible_count_as_at,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'employer_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "Employer" (
      "employer_ref", "name", "eligible_count", "eligible_count_as_at",
      "source_updated_at", "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      s.employer_ref, s.name, s.eligible_count, s.eligible_count_as_at,
      s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
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
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Employees: upsert on (employer_ref, payroll_ref, observed_at)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_employees(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'payroll_ref')::VARCHAR(50) AS payroll_ref,
      (row->>'observed_at')::TIMESTAMP AS observed_at,
      (row->>'site_name')::VARCHAR(150) AS site_name,
      (row->>'income_band')::VARCHAR(30) AS income_band,
      (row->>'eligible_from')::TIMESTAMP AS eligible_from,
      (row->>'eligible_to')::TIMESTAMP AS eligible_to,
      (row->>'active')::BOOLEAN AS active,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'employer_ref') IS NOT NULL AND (row->>'payroll_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "Employee" (
      "employer_ref", "payroll_ref", "observed_at", "site_name", "income_band",
      "eligible_from", "eligible_to", "active", "source_updated_at",
      "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      s.employer_ref, s.payroll_ref, s.observed_at, s.site_name, s.income_band,
      s.eligible_from, s.eligible_to, s.active, s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
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
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Platform Users: upsert on (employer_ref, payroll_ref)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_platform_users(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'payroll_ref')::VARCHAR(50) AS payroll_ref,
      (row->>'enrolled_at')::TIMESTAMP AS enrolled_at,
      (row->>'activated_at')::TIMESTAMP AS activated_at,
      (row->>'has_credit_profile')::BOOLEAN AS has_credit_profile,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'employer_ref') IS NOT NULL AND (row->>'payroll_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "PlatformUser" (
      "employer_ref", "payroll_ref", "enrolled_at", "activated_at",
      "has_credit_profile", "source_updated_at", "source_deleted_at",
      "created_at", "updated_at"
    )
    SELECT
      s.employer_ref, s.payroll_ref, s.enrolled_at, s.activated_at,
      s.has_credit_profile, s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
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
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Journeys: upsert on journey_ref
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_journeys(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'journey_ref')::VARCHAR(30) AS journey_ref,
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'payroll_ref')::VARCHAR(50) AS payroll_ref,
      (row->>'type')::VARCHAR(30) AS type,
      (row->>'status')::VARCHAR(30) AS status,
      (row->>'started_at')::TIMESTAMP AS started_at,
      (row->>'completed_at')::TIMESTAMP AS completed_at,
      (row->>'monthly_saving_rand')::DECIMAL(18,2) AS monthly_saving_rand,
      (row->>'balance_impact_rand')::DECIMAL(18,2) AS balance_impact_rand,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'journey_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "Journey" (
      "journey_ref", "employer_ref", "payroll_ref", "type", "status",
      "started_at", "completed_at", "monthly_saving_rand", "balance_impact_rand",
      "source_updated_at", "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      s.journey_ref, s.employer_ref, s.payroll_ref, s.type, s.status,
      s.started_at, s.completed_at, s.monthly_saving_rand, s.balance_impact_rand,
      s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
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
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Debt Accounts: upsert on account_ref
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_debt_accounts(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'account_ref')::VARCHAR(30) AS account_ref,
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'payroll_ref')::VARCHAR(50) AS payroll_ref,
      (row->>'observed_at')::TIMESTAMP AS observed_at,
      (row->>'closed_at')::TIMESTAMP AS closed_at,
      (row->>'creditor_name')::VARCHAR(150) AS creditor_name,
      (row->>'credit_type')::VARCHAR(50) AS credit_type,
      (row->>'balance_rand')::DECIMAL(18,2) AS balance_rand,
      (row->>'in_arrears')::BOOLEAN AS in_arrears,
      (row->>'state')::VARCHAR(40) AS state,
      (row->>'challenge_status')::VARCHAR(40) AS challenge_status,
      (row->>'journey_ref')::VARCHAR(30) AS journey_ref,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'account_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "DebtAccount" (
      "account_ref", "employer_ref", "payroll_ref", "observed_at", "closed_at",
      "creditor_name", "credit_type", "balance_rand", "in_arrears", "state",
      "challenge_status", "journey_ref", "source_updated_at", "source_deleted_at",
      "created_at", "updated_at"
    )
    SELECT
      s.account_ref, s.employer_ref, s.payroll_ref, s.observed_at, s.closed_at,
      s.creditor_name, s.credit_type, s.balance_rand, s.in_arrears, s.state,
      s.challenge_status, s.journey_ref, s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
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
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Policies: upsert on policy_ref
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_policies(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'policy_ref')::VARCHAR(30) AS policy_ref,
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'payroll_ref')::VARCHAR(50) AS payroll_ref,
      (row->>'observed_at')::TIMESTAMP AS observed_at,
      (row->>'effective_from')::TIMESTAMP AS effective_from,
      (row->>'effective_to')::TIMESTAMP AS effective_to,
      (row->>'resolved_at')::TIMESTAMP AS resolved_at,
      (row->>'type')::VARCHAR(30) AS type,
      (row->>'premium_rand')::DECIMAL(18,2) AS premium_rand,
      (row->>'is_wasteful')::BOOLEAN AS is_wasteful,
      (row->>'is_resolved')::BOOLEAN AS is_resolved,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'policy_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "Policy" (
      "policy_ref", "employer_ref", "payroll_ref", "observed_at", "effective_from",
      "effective_to", "resolved_at", "type", "premium_rand", "is_wasteful",
      "is_resolved", "source_updated_at", "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      s.policy_ref, s.employer_ref, s.payroll_ref, s.observed_at, s.effective_from,
      s.effective_to, s.resolved_at, s.type, s.premium_rand, s.is_wasteful,
      s.is_resolved, s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
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
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Ratings: upsert on rating_ref
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_ratings(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'rating_ref')::VARCHAR(30) AS rating_ref,
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'payroll_ref')::VARCHAR(50) AS payroll_ref,
      (row->>'journey_type')::VARCHAR(30) AS journey_type,
      (row->>'stars')::SMALLINT AS stars,
      (row->>'created_at')::TIMESTAMP AS created_at,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'rating_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "Rating" (
      "rating_ref", "employer_ref", "payroll_ref", "journey_type", "stars",
      "created_at", "source_updated_at", "source_deleted_at", "updated_at"
    )
    SELECT
      s.rating_ref, s.employer_ref, s.payroll_ref, s.journey_type, s.stars,
      s.created_at, s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW()
    FROM source s
    ON CONFLICT ("rating_ref") DO UPDATE SET
      "stars" = EXCLUDED."stars",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Referrals: upsert on referral_ref
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_referrals(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'referral_ref')::VARCHAR(30) AS referral_ref,
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'payroll_ref')::VARCHAR(50) AS payroll_ref,
      (row->>'channel')::VARCHAR(100) AS channel,
      (row->>'shared_at')::TIMESTAMP AS shared_at,
      (row->>'converted')::BOOLEAN AS converted,
      (row->>'converted_at')::TIMESTAMP AS converted_at,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'referral_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "Referral" (
      "referral_ref", "employer_ref", "payroll_ref", "channel", "shared_at",
      "converted", "converted_at", "source_updated_at", "source_deleted_at",
      "created_at", "updated_at"
    )
    SELECT
      s.referral_ref, s.employer_ref, s.payroll_ref, s.channel, s.shared_at,
      s.converted, s.converted_at, s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
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
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Salary Advances: upsert on salary_advance_id
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_salary_advances(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'salary_advance_id')::VARCHAR(30) AS salary_advance_id,
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'client_id')::VARCHAR(30) AS client_id,
      (row->>'payroll_ref')::VARCHAR(50) AS payroll_ref,
      (row->>'amount')::DECIMAL(18,2) AS amount,
      (row->>'salary_advance_status')::VARCHAR(30) AS salary_advance_status,
      (row->>'bank_account_verification_status')::VARCHAR(30) AS bank_account_verification_status,
      (row->>'blacklisted')::BOOLEAN AS blacklisted,
      (row->>'advanced_at')::TIMESTAMP AS advanced_at,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'salary_advance_id') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "SalaryAdvance" (
      "salary_advance_id", "employer_ref", "client_id", "payroll_ref", "amount",
      "salary_advance_status", "bank_account_verification_status", "blacklisted",
      "advanced_at", "source_updated_at", "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      s.salary_advance_id, s.employer_ref, s.client_id, s.payroll_ref, s.amount,
      s.salary_advance_status, s.bank_account_verification_status, s.blacklisted,
      s.advanced_at, s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
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
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────
-- Workforce Snapshots: upsert on (employer_ref, as_of_date)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_upsert_workforce_snapshots(
  p_rows JSONB DEFAULT NULL
)
RETURNS TABLE (inserted BIGINT, updated BIGINT, deleted BIGINT) AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated BIGINT := 0;
  v_deleted BIGINT := 0;
BEGIN
  WITH source AS (
    SELECT
      (row->>'employer_ref')::VARCHAR(20) AS employer_ref,
      (row->>'as_of_date')::TIMESTAMP AS as_of_date,
      (row->>'eligible_count')::INT AS eligible_count,
      (row->>'source_updated_at')::TIMESTAMP AS source_updated_at,
      (row->>'is_deleted')::BOOLEAN AS is_deleted
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::JSONB)) AS row
    WHERE (row->>'employer_ref') IS NOT NULL
  ),
  upsert_result AS (
    INSERT INTO "EmployerHeadcountSnapshot" (
      "employer_ref", "as_of_date", "eligible_count", "source_updated_at",
      "source_deleted_at", "created_at", "updated_at"
    )
    SELECT
      s.employer_ref, s.as_of_date, s.eligible_count, s.source_updated_at,
      CASE WHEN s.is_deleted THEN NOW() ELSE NULL END,
      NOW(), NOW()
    FROM source s
    ON CONFLICT ("employer_ref", "as_of_date") DO UPDATE SET
      "eligible_count" = EXCLUDED."eligible_count",
      "source_updated_at" = EXCLUDED."source_updated_at",
      "source_deleted_at" = EXCLUDED."source_deleted_at",
      "updated_at" = NOW()
    RETURNING xmax = 0 AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert)::BIGINT,
    COUNT(*) FILTER (WHERE NOT is_insert)::BIGINT,
    0::BIGINT
  INTO v_inserted, v_updated, v_deleted
  FROM upsert_result;

  RETURN QUERY SELECT v_inserted, v_updated, v_deleted;
END;
$$ LANGUAGE plpgsql;

