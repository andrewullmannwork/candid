-- =============================================================================
-- MIGRATION 123 — Backfill insurance_plans OON plan-identity fields from prior
--                 cite-grade Haiku extractions (Ing-L, pre-launch backend
--                 hardening; S128)
-- =============================================================================
--
-- Companion to the Ing-L voted-parser fix that closes the per-attempt voting
-- gap on 4 OON plan-identity fields. This migration backfills any existing
-- insurance_plans rows where the voted-parser bug previously dropped OON
-- values to NULL, using prior cite-grade Haiku extractions stored in
-- canonical_haiku_extractions (mig 084).
--
-- WHY THIS MIGRATION EXISTS
--
-- Pre-Ing-L, the SBC voted-parser's `voteImportantQuestions` fields list was
-- missing the 4 OON plan-identity keys (outDeductibleIndividual /
-- outDeductibleFamily / outOopMaxIndividual / outOopMaxFamily) + 2 ACA keys
-- (isAcaCompliant / acaComplianceBasis). For fields NOT in the voting list,
-- the merged result took whatever attempts[0] produced — values from
-- attempts[1] / [2] were silently discarded. When attempts[0] happened to
-- return null on OON (Haiku layout-randomness on 1st attempt), the merged
-- result was null even though subsequent attempts succeeded. Downstream
-- legacy-adapter → planInsert → INSERT into insurance_plans persisted NULL.
-- /plan and /compare displayed NULL ("—") for OON.
--
-- This migration recovers OON values for affected insurance_plans rows where
-- a cite-grade canonical_haiku_extractions row exists for the same canonical
-- (any user's earlier upload happened to succeed on OON).
--
-- BACKFILL STRATEGY
--
-- canonical_haiku_extractions stores one cite-grade-verified row per
-- (canonical_plan_id, field_name, haiku_run_id). For the 4 OON field_names,
-- pick the MOST-RECENT verified extraction per canonical. Pivot the 4 rows
-- per canonical into a single record. UPDATE insurance_plans rows linked to
-- that canonical where the OON field is currently NULL — preserve any
-- non-null values (COALESCE pattern) for race-safety + forward-compat with
-- the Ing-L fix that will land OON correctly on new uploads.
--
-- COVERAGE EXPECTATION
--
-- LOW (~0-10%). canonical_haiku_extractions filters to verified-excerpt +
-- verified-section rows; if the voted-parser bug fired on a given user's
-- upload, that user's canonical_haiku_extractions write for the OON field
-- ALSO has empty source_excerpt (because attempts[0]'s patternP8 dropped
-- alongside the value). So OON extraction rows in this table only exist for
-- (canonical, user) pairs where attempts[0] happened to succeed. For small
-- PROD with N≤8 SBC uploads, coverage is near zero — Phase B Haiku re-extract
-- admin script handles the rest.
--
-- IDEMPOTENT — COALESCE preserves any existing non-null values.
-- RACE-SAFE — WHERE clause filters to canonicals where extraction rows exist.
-- Per Pattern 1 #14 + Rule #4 exception clause: seed migrations may write to
-- user-scoped insurance_plans tables. Admin tool path (this mig) is allowed.

BEGIN;

WITH oon_extractions AS (
  SELECT DISTINCT ON (canonical_plan_id, field_name)
    canonical_plan_id,
    field_name,
    extracted_value,
    created_at
  FROM canonical_haiku_extractions
  WHERE field_name IN (
      'out_deductible_individual',
      'out_deductible_family',
      'out_oop_max_individual',
      'out_oop_max_family'
    )
    AND extracted_value IS NOT NULL
    AND extracted_value::text <> 'null'::text
    AND source_excerpt_verified = 'verified'
    AND source_section_verified = true
  ORDER BY canonical_plan_id, field_name, created_at DESC
),
pivoted AS (
  SELECT
    canonical_plan_id,
    MAX(CASE WHEN field_name = 'out_deductible_individual' THEN (extracted_value #>> '{}')::numeric END) AS out_ded_ind,
    MAX(CASE WHEN field_name = 'out_deductible_family' THEN (extracted_value #>> '{}')::numeric END) AS out_ded_fam,
    MAX(CASE WHEN field_name = 'out_oop_max_individual' THEN (extracted_value #>> '{}')::numeric END) AS out_oop_ind,
    MAX(CASE WHEN field_name = 'out_oop_max_family' THEN (extracted_value #>> '{}')::numeric END) AS out_oop_fam
  FROM oon_extractions
  GROUP BY canonical_plan_id
)
UPDATE insurance_plans ip
SET
  out_deductible_individual = COALESCE(ip.out_deductible_individual, p.out_ded_ind),
  out_deductible_family     = COALESCE(ip.out_deductible_family,     p.out_ded_fam),
  out_oop_max_individual    = COALESCE(ip.out_oop_max_individual,    p.out_oop_ind),
  out_oop_max_family        = COALESCE(ip.out_oop_max_family,        p.out_oop_fam),
  updated_at = now()
FROM pivoted p
WHERE ip.canonical_plan_id = p.canonical_plan_id
  AND (
    (ip.out_deductible_individual IS NULL AND p.out_ded_ind IS NOT NULL) OR
    (ip.out_deductible_family     IS NULL AND p.out_ded_fam IS NOT NULL) OR
    (ip.out_oop_max_individual    IS NULL AND p.out_oop_ind IS NOT NULL) OR
    (ip.out_oop_max_family        IS NULL AND p.out_oop_fam IS NOT NULL)
  );

-- Diagnostic snapshot
DO $$
DECLARE
  v_null_remaining INTEGER;
  v_extractions_available INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_null_remaining
  FROM insurance_plans
  WHERE source IN ('sbc_upload', 'sbc_parsed')
    AND (
      out_deductible_individual IS NULL OR
      out_deductible_family     IS NULL OR
      out_oop_max_individual    IS NULL OR
      out_oop_max_family        IS NULL
    );

  SELECT COUNT(DISTINCT canonical_plan_id) INTO v_extractions_available
  FROM canonical_haiku_extractions
  WHERE field_name IN ('out_deductible_individual', 'out_deductible_family', 'out_oop_max_individual', 'out_oop_max_family')
    AND extracted_value IS NOT NULL
    AND extracted_value::text <> 'null'::text
    AND source_excerpt_verified = 'verified'
    AND source_section_verified = true;

  RAISE NOTICE 'Ing-L cheap SQL backfill complete. insurance_plans (sbc source) with any NULL OON field remaining: %; distinct canonicals with verified OON extractions available: %.',
    v_null_remaining, v_extractions_available;
END $$;

COMMIT;
