-- Migration 088: S74.5 D13 — Zero-cost-share code registry (ACA preventive + ACIP vaccine)
--
-- Per plans/s74.5_categorization_flywheel.md v2 §7.1 + Q-A LOCK + Q-B LOCK + Q-K LOCK.
--
-- WHY THIS MIGRATION EXISTS
--
-- ACA-compliant plans cover certain services at $0 patient cost-share regardless
-- of deductible / copay / network status (Title 42 § 300gg-13). USPSTF Grade A/B
-- recommendations, ACIP-recommended vaccines, HRSA Women's Preventive Services,
-- and Bright Futures pediatric preventive are all in this bucket. ACIP-
-- recommended routine vaccines are similarly always $0 patient cost.
--
-- Without this registry, audit cannot flag Andrew's $146 erroneous payment on
-- covered preventive + vaccine services (Session 81 walkthrough finding).
-- D15 claim-header arithmetic catches unallocated balances; D13 catches the
-- specific "this code is always $0" overcharge type.
--
-- WHAT THIS MIGRATION ADDS
--
-- zero_cost_share_codes table — unified ACA preventive + ACIP vaccine table
-- per Q-B LOCK (one table, coverage_basis discriminator, NULL-able specialized
-- columns). Composite UNIQUE on (billing_code, billing_code_type, coverage_basis)
-- so the same code can appear under multiple bases (rare; e.g., influenza vaccine
-- is both ACIP and ACA preventive depending on framing).
--
-- Seeded via `scripts/seed-zero-cost-share-codes.ts` (separate script for
-- annual refresh without new migrations). Initial seed targets ~70 highest-
-- volume codes from HRSA + USPSTF + ACOG + Bright Futures + CDC ACIP; expand
-- to full ~200 in follow-up sessions as authoritative cross-referencing
-- completes.
--
-- BACKOUT — additive table only. No dependent code yet (audit hook gated
-- behind s74_5_categorization_flywheel_v1 flag).

BEGIN;

CREATE TABLE IF NOT EXISTS zero_cost_share_codes (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_code              TEXT NOT NULL,
  billing_code_type         TEXT NOT NULL
    CHECK (billing_code_type IN ('CPT','HCPCS_L2','G_CODE','CAT_II')),
  coverage_basis            TEXT NOT NULL
    CHECK (coverage_basis IN ('ACA_preventive','ACIP_vaccine')),
  category                  TEXT,                   -- 'screening' | 'counseling' | 'immunization' | 'admin' | 'contraception' | 'wellness_visit' | ...
  uspstf_grade              TEXT
    CHECK (uspstf_grade IS NULL OR uspstf_grade IN ('A','B')),
  age_min                   INT CHECK (age_min IS NULL OR age_min >= 0),
  age_max                   INT CHECK (age_max IS NULL OR age_max >= 0),
  sex                       TEXT CHECK (sex IS NULL OR sex IN ('M','F')),
  frequency_limit           TEXT,                   -- informational v1; not enforced (e.g., "1/year", "1/3yr")
  effective_from            DATE NOT NULL DEFAULT '2010-09-23',  -- ACA effective date
  retired_at                DATE,                   -- annual refresh sets when guideline removes
  source_url                TEXT NOT NULL,          -- HRSA / USPSTF / ACOG / Bright Futures / CDC ACIP citation
  source_label              TEXT NOT NULL,          -- human-readable label e.g. "USPSTF 2025 Grade A"
  display_name              TEXT NOT NULL,          -- plain-English label for findings UI (Candid-authored; NOT AMA-licensed CPT description)
  notes                     TEXT,                   -- admin-internal context

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (billing_code, billing_code_type, coverage_basis)
);

CREATE INDEX IF NOT EXISTS idx_zero_cost_share_code_lookup
  ON zero_cost_share_codes (billing_code, billing_code_type)
  WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_zero_cost_share_coverage_basis
  ON zero_cost_share_codes (coverage_basis)
  WHERE retired_at IS NULL;

COMMENT ON TABLE zero_cost_share_codes IS
  'S74.5 D13 (Session 82). Unified ACA preventive + ACIP vaccine registry per Q-B LOCK. Audit consults BEFORE plan-coverage check (src/lib/audit/zero-cost-share.ts). When a line items code matches an active row AND user demographics pass eligibility filter, expected patient cost = $0; flag overcharge if actual patient cost > $0 (finding type zero_cost_share_overcharge with source_url for dispute evidence). Seeded via scripts/seed-zero-cost-share-codes.ts (idempotent UPSERT). v1 seed: ~70 highest-volume codes. Expansion via admin queue + annual seed-script refresh. Out of scope for D13: state Medicaid mandates / MHPAEA / NSA / HPT (separate Subplan family per Q-K LOCK).';

COMMENT ON COLUMN zero_cost_share_codes.display_name IS
  'Plain-English label authored by Candid for use in findings UI + dispute evidence text. Never duplicate AMA-licensed CPT descriptions per Compliance Hard Rule 3.';

ALTER TABLE zero_cost_share_codes ENABLE ROW LEVEL SECURITY;

-- Public reference data: any authenticated client can SELECT (audit + admin queue read it)
CREATE POLICY "zero_cost_share_codes_public_select"
  ON zero_cost_share_codes FOR SELECT
  USING (true);

CREATE POLICY "zero_cost_share_codes_admin_all"
  ON zero_cost_share_codes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.is_admin = true
    )
  );

CREATE TRIGGER zero_cost_share_codes_updated_at
  BEFORE UPDATE ON zero_cost_share_codes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMIT;
