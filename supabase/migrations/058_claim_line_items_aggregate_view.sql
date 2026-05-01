-- Migration 058: claim_line_items_aggregate view for Pattern P-8 citation-grade
-- source provenance privacy carve-out.
--
-- Per Phase 3.1B Subplan §Q-P3.1B-5 v2 (revised per skeptical-audit Issue 3): this
-- view is a TIGHT PRIVACY-POSITIVE ALLOWLIST, not a column mirror. It exposes only
-- the columns aggregate consumers (Care, Mestimate, data exports) actually need,
-- and drops the rest to prevent identity / PHI / timing-leak risks.
--
-- Drift in the wrong direction — forgetting to add a NEW column to the view — is a
-- missing-feature, not a privacy hole. Future columns added to claim_line_items do
-- NOT auto-flow through; aggregate consumers explicitly request additions via new
-- migrations with privacy review.
--
-- The 5 source_* sub-keys (Pattern P-8) are stripped from the field_provenance JSONB
-- exposed via this view. Direct claim_line_items table reads remain row-scoped via
-- existing RLS — only this view's consumers see the sanitized provenance.
--
-- Additive; no rollback needed (DROP VIEW claim_line_items_aggregate; if obsolete).

CREATE OR REPLACE VIEW claim_line_items_aggregate AS
SELECT
  -- Identity (stable join keys + service identity for aggregation)
  cli.id,
  cli.concept_id,
  cli.service_slug,
  cli.billing_code,
  cli.billing_code_type,

  -- Service context
  cli.units,
  cli.modifier_codes,
  cli.place_of_service_code,
  cli.plan_year,

  -- Cost transparency core (Care + Mestimate use cases)
  cli.billed_amount,
  cli.allowed_amount,
  cli.insurance_paid,
  cli.patient_owes,

  -- Provenance (Pattern 1 corroboration metadata)
  -- field_provenance JSONB is SANITIZED here — Pattern P-8 sub-keys stripped per row.
  -- Per Q-DR-3B-2, claim_line_items intentionally has NO row-level `confidence` column
  -- (transactional tables don't use the row aggregate; only canonical_plan_services +
  -- plan_covered_services do). Aggregate consumers infer per-row confidence from the
  -- per-field entries inside field_provenance if needed.
  (
    SELECT jsonb_object_agg(
      key,
      CASE
        WHEN jsonb_typeof(value) = 'object' THEN
          value
            - 'source_excerpt'
            - 'source_excerpt_verified'
            - 'source_excerpt_extraction_method'
            - 'source_section_hint'
            - 'source_section_verified'
        ELSE value
      END
    )
    FROM jsonb_each(cli.field_provenance)
  ) AS field_provenance

  -- DELIBERATELY EXCLUDED (drop list — privacy-positive defaults):
  --   cli.claim_id                       -- joins to claims.user_id; identity leak
  --   cli.line_number                    -- low aggregate value; possible timing leak in narrow cohorts
  --   cli.description                    -- raw text from upload; may contain PII (provider/patient names)
  --   cli.adjustment_reason_code         -- sensitive denial reasons; conservative carve-out
  --   cli.adjustment_reason_description  -- sensitive denial reasons; conservative carve-out
  --   cli.metadata                       -- opaque JSONB; opt-in via separate migration when consumers need
  --   cli.created_at                     -- timing leak risk
  --   cli.updated_at                     -- timing leak risk
FROM claim_line_items cli;

COMMENT ON VIEW claim_line_items_aggregate IS
  'Pattern P-8 (Phase 3.1B) — citation-grade source provenance privacy carve-out for aggregate consumers (Care, Mestimate, data exports). TIGHT PRIVACY-POSITIVE ALLOWLIST — exposes only the columns aggregate consumers need. New columns added to claim_line_items do NOT auto-flow through; aggregate consumers explicitly request additions via new migrations with privacy review. The 5 source_* sub-keys (source_excerpt, source_excerpt_verified, source_excerpt_extraction_method, source_section_hint, source_section_verified) are stripped from field_provenance JSONB. Direct claim_line_items reads remain row-scoped via existing RLS. See Candid_Parse_Patterns.md Pattern P-8 + plans/phase_3.1B_eob_validation_and_source_excerpt.md.';
