-- Migration 165: Canonical Field-Name Alignment — Phase 1 (canonical_plan_services)
-- F.0 per plans/canonical_field_alignment.md (S207). ADDITIVE + REVERSIBLE.
--
-- WHY
--   Per-service corroboration crosses two tables that name the same field differently:
--   user plan_covered_services uses in_copay / covered / prior_auth_required; the
--   48,552-row cold-start canonical_plan_services uses copay / is_covered /
--   requires_prior_auth (legacy drift, predates the in_/out_ convention). The mig-156
--   evaluator reads BOTH tables by ONE p_field_name, so it can never match both
--   (verified live: in_copay reads user rows but MISSES the cold-start; copay reads the
--   cold-start but misses user rows). This migration brings canonical_plan_services UP to
--   the in_/out_ convention so ONE name flows end-to-end.
--
-- WHAT (Phase 1 of 5 — canonical_plan_services only; canonical_plans is Phase 5)
--   1. ADD the 5 aligned columns (replicating the legacy DEFAULTs).
--   2. align_mirror_cps_row() + a BEFORE INSERT/UPDATE trigger that keeps the aligned
--      columns + provenance keys in sync with the legacy ones on every write
--      (Phase-1 direction = legacy -> aligned; legacy stays authoritative this phase).
--   Existing 48,552 rows are populated by the one-time backfill
--   (scripts/calibration/fixtures/canonical-field-align/backfill.sql), run AFTER this migration.
--   Old columns + old provenance keys remain populated + authoritative until Phase 3/4.
--
-- LIVE-VERIFIED (S207, PROD 9591ba2): no generated cols / views / matviews / RLS / FK /
--   index / partition on the renamed columns; target names free; realtime publication none.
--   Only apply_promotion_event (live) + the DEAD upsert_canonical_services_with_merge
--   (mig 064, sunset mig 069, zero callers) reference these columns;
--   evaluate_pattern1_corroboration reads by dynamic p_field_name (UNTOUCHED by alignment).
--
-- TRIGGER FIRE-ORDER (critical): canonical_plan_services already has
--   canonical_plan_services_confidence_recompute (mig 056) which sets
--   confidence = MIN(non-'_' provenance keys' confidence) whenever field_provenance changes.
--   BEFORE row triggers fire in NAME order, so this trigger is named
--   canonical_plan_services_align_dualwrite ('align' < 'confidence') to fire FIRST -> the
--   confidence recompute then sees the dual-keyed provenance. Because the aligned twin
--   carries the SAME confidence as its legacy key, MIN is unchanged (asserted by the
--   parity gate: confidence byte-identical pre/post).
--
-- ROLLBACK (Phase 1 is fully reversible — old data untouched, zero loss):
--   DROP TRIGGER IF EXISTS canonical_plan_services_align_dualwrite ON canonical_plan_services;
--   DROP FUNCTION IF EXISTS align_mirror_cps_row();
--   ALTER TABLE canonical_plan_services
--     DROP COLUMN IF EXISTS in_copay, DROP COLUMN IF EXISTS in_coinsurance,
--     DROP COLUMN IF EXISTS in_deductible_applies, DROP COLUMN IF EXISTS covered,
--     DROP COLUMN IF EXISTS prior_auth_required;

-- ── 1. ADD aligned columns (constant DEFAULTs => metadata-only, no table rewrite on 48k rows) ──
ALTER TABLE canonical_plan_services
  ADD COLUMN IF NOT EXISTS in_copay              NUMERIC,
  ADD COLUMN IF NOT EXISTS in_coinsurance        NUMERIC,
  ADD COLUMN IF NOT EXISTS in_deductible_applies BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS covered               BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS prior_auth_required   BOOLEAN DEFAULT false;

COMMENT ON COLUMN canonical_plan_services.in_copay IS
  'F.0 mig 165: aligned name for legacy copay (in_/out_ convention; matches plan_covered_services). Phase 1: mirrored from copay via align_mirror_cps_row; copay authoritative until Phase 2.';
COMMENT ON COLUMN canonical_plan_services.in_coinsurance IS
  'F.0 mig 165: aligned name for legacy coinsurance (decimal-stored). Mirrored from coinsurance; legacy authoritative until Phase 2.';
COMMENT ON COLUMN canonical_plan_services.in_deductible_applies IS
  'F.0 mig 165: aligned name for legacy deductible_applies. Mirrored; legacy authoritative until Phase 2.';
COMMENT ON COLUMN canonical_plan_services.covered IS
  'F.0 mig 165: aligned name for legacy is_covered. Mirrored from is_covered; legacy authoritative until Phase 2.';
COMMENT ON COLUMN canonical_plan_services.prior_auth_required IS
  'F.0 mig 165: aligned name for legacy requires_prior_auth. Mirrored; legacy authoritative until Phase 2.';

-- ── 2. Dual-write mirror: legacy -> aligned on every write (Phase 1 direction) ──
CREATE OR REPLACE FUNCTION align_mirror_cps_row()
RETURNS TRIGGER AS $$
BEGIN
  -- typed columns: aligned := legacy (NULL-preserving)
  NEW.in_copay              := NEW.copay;
  NEW.in_coinsurance        := NEW.coinsurance;
  NEW.in_deductible_applies := NEW.deductible_applies;
  NEW.covered               := NEW.is_covered;
  NEW.prior_auth_required   := NEW.requires_prior_auth;

  -- provenance: for each legacy IN-NETWORK key present, set its aligned twin with the
  -- IDENTICAL nested object (value/source/sources/confidence/...). out_* keys already
  -- match the convention -> left untouched. Legacy keys are PRESERVED (dual-key).
  IF NEW.field_provenance IS NOT NULL AND NEW.field_provenance <> '{}'::jsonb THEN
    IF NEW.field_provenance ? 'copay'              THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_copay',              NEW.field_provenance->'copay'); END IF;
    IF NEW.field_provenance ? 'coinsurance'        THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_coinsurance',        NEW.field_provenance->'coinsurance'); END IF;
    IF NEW.field_provenance ? 'deductible_applies' THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_deductible_applies', NEW.field_provenance->'deductible_applies'); END IF;
    IF NEW.field_provenance ? 'is_covered'         THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('covered',               NEW.field_provenance->'is_covered'); END IF;
    IF NEW.field_provenance ? 'requires_prior_auth' THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('prior_auth_required',  NEW.field_provenance->'requires_prior_auth'); END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_plan_services_align_dualwrite ON canonical_plan_services;
CREATE TRIGGER canonical_plan_services_align_dualwrite
  BEFORE INSERT OR UPDATE ON canonical_plan_services
  FOR EACH ROW
  EXECUTE FUNCTION align_mirror_cps_row();
