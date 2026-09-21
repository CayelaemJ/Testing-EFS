-- ═══════════════════════════════════════════════════════════════════════════
-- DAILY SCHEDULED REFRESH
--
-- Simple cron job: Once per day, truncate Postgres tables and reload from
-- MySQL source views. Fast, simple, zero complexity.
--
-- Schedule: 0 2 * * * (2 AM daily, or whenever suits your business)
-- ═══════════════════════════════════════════════════════════════════════════

-- Single procedure: refresh all 10 reports at once
CREATE OR REPLACE PROCEDURE refresh_all_reports()
LANGUAGE plpgsql
AS $$
BEGIN
  -- Truncate all destination tables. Fast and safe if you sync daily.
  TRUNCATE TABLE "Employer" CASCADE;
  TRUNCATE TABLE "Employee" CASCADE;
  TRUNCATE TABLE "PlatformUser" CASCADE;
  TRUNCATE TABLE "Journey" CASCADE;
  TRUNCATE TABLE "DebtAccount" CASCADE;
  TRUNCATE TABLE "Policy" CASCADE;
  TRUNCATE TABLE "Rating" CASCADE;
  TRUNCATE TABLE "Referral" CASCADE;
  TRUNCATE TABLE "SalaryAdvance" CASCADE;
  TRUNCATE TABLE "EmployerHeadcountSnapshot" CASCADE;

  -- Reload from MySQL source views via postgres_fdw
  -- (Requires: CREATE EXTENSION postgres_fdw; + foreign server setup)
  -- For now, this is a template. Replace v_employers with actual FDW references.
  
  INSERT INTO "Employer" (
    "employer_ref", "name", "eligible_count", "eligible_count_as_at",
    "source_updated_at", "source_deleted_at", "created_at", "updated_at"
  )
  SELECT
    employer_ref, name, eligible_count, eligible_count_as_at,
    source_updated_at,
    CASE WHEN is_deleted THEN NOW() ELSE NULL END,
    NOW(), NOW()
  FROM v_employers;

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
  FROM v_employees;

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
  FROM v_platform_users;

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
  FROM v_journeys;

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
  FROM v_debt_accounts;

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
  FROM v_policies;

  INSERT INTO "Rating" (
    "rating_ref", "employer_ref", "payroll_ref", "journey_type", "stars",
    "created_at", "source_updated_at", "source_deleted_at", "updated_at"
  )
  SELECT
    rating_ref, employer_ref, payroll_ref, journey_type, stars,
    created_at, source_updated_at,
    CASE WHEN is_deleted THEN NOW() ELSE NULL END,
    NOW()
  FROM v_ratings;

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
  FROM v_referrals;

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
  FROM v_salary_advances;

  INSERT INTO "EmployerHeadcountSnapshot" (
    "employer_ref", "as_of_date", "eligible_count", "source_updated_at",
    "source_deleted_at", "created_at", "updated_at"
  )
  SELECT
    employer_ref, as_of_date, eligible_count, source_updated_at,
    CASE WHEN is_deleted THEN NOW() ELSE NULL END,
    NOW(), NOW()
  FROM v_workforce_snapshots;

  RAISE NOTICE 'Daily refresh completed at %', NOW();
END;
$$;

-- Create a cron job to run daily at 2 AM (requires pg_cron extension)
-- SELECT cron.schedule('refresh-reports', '0 2 * * *', 'CALL refresh_all_reports()');
-- OR run manually: CALL refresh_all_reports();

