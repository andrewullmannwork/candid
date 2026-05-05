-- Migration 073: Backfill `field_provenance` JSONB on smart-skipped insurance_plans
-- and plan_covered_services rows that were copied from canonical without provenance
-- (CF-19a — Session 64).
--
-- BACKGROUND
-- Smart-skip path (extraction-dedup.linkDocumentToCanonical) copies canonical_plans
-- → insurance_plans and canonical_plan_services → plan_covered_services on file-hash
-- match against a Haiku-stable canonical, but the legacy code path did NOT populate
-- field_provenance JSONB. Those rows persist with `field_provenance = '{}'::jsonb`
-- (mig 056 / mig 063 default) and render as `state=estimated, reason=self_source_no_cite`
-- on the /plan page even though the values came from a corroborated canonical.
--
-- Q-S64-3 (user direction Session 64): no live user data; safe to migrate aggressively.
--
-- WHAT THIS MIGRATION DOES
-- Targets rows where:
--   (a) `insurance_plans.canonical_plan_id IS NOT NULL` (linked to canonical)
--   (b) `field_provenance = '{}'::jsonb` (no provenance written)
--   (c) `source_document_id` traces to a `document_extraction_log.action =
--       'skipped_canonical_stable'` row
--
-- For each matching row, synthesizes a `field_provenance` JSONB with one entry per
-- populated plan-identity column (in_deductible_*, in_oop_max_*, plan_name, etc.)
-- using `source = 'canonical_inherited'` and the canonical's current verification_count
-- snapshot (compute-on-read in code; just record source here).
--
-- For plan_covered_services rows (smart-skipped service rows), inherits canonical's
-- field_provenance entries directly when canonical has them; else synthesizes
-- canonical_inherited entries for populated columns (in_copay/in_coinsurance/etc).
--
-- PATTERN COMPLIANCE
-- - Pattern 1 #14: writes to user-scoped tables only (insurance_plans + plan_covered_services).
--   No canonical writes. Backfill is a one-time data integrity correction, not a
--   user-initiated event.
-- - CLAUDE.md Rule #7 (additive only): no schema changes; UPDATE-only.
-- - Confidence preserved: mig 056 trigger recomputes row-level confidence as MIN
--   over field_provenance entries. We use canonical's verification_count semantic
--   threshold confidence (0.5 single-source baseline matches doc_extraction).

-- ── Backfill insurance_plans ────────────────────────────────────────────────
-- Synthesize field_provenance entries for plan-identity columns where value is non-null.
-- Source: 'canonical_inherited'. Confidence: 0.5 (doc_extraction baseline; threshold
-- promotion happens compute-on-read via canonical_plans.verification_count).
WITH smart_skip_plans AS (
  SELECT DISTINCT ip.id
  FROM insurance_plans ip
  JOIN documents d ON d.id = ip.source_document_id
  JOIN document_extraction_log del ON del.document_id = d.id
  WHERE ip.canonical_plan_id IS NOT NULL
    AND ip.field_provenance = '{}'::jsonb
    AND del.action = 'skipped_canonical_stable'
)
UPDATE insurance_plans
  SET field_provenance = jsonb_strip_nulls(
    jsonb_build_object(
      'plan_name', CASE WHEN plan_name IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'insurer_name', CASE WHEN insurer_name IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'plan_type', CASE WHEN plan_type IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'plan_year', CASE WHEN plan_year IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'in_deductible_individual', CASE WHEN in_deductible_individual IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'in_deductible_family', CASE WHEN in_deductible_family IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'in_oop_max_individual', CASE WHEN in_oop_max_individual IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'in_oop_max_family', CASE WHEN in_oop_max_family IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'out_deductible_individual', CASE WHEN out_deductible_individual IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END,
      'out_oop_max_individual', CASE WHEN out_oop_max_individual IS NOT NULL THEN
        jsonb_build_object(
          'source', 'canonical_inherited',
          'confidence', 0.5,
          'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ) ELSE NULL END
    )
  )
WHERE id IN (SELECT id FROM smart_skip_plans);

-- ── Backfill plan_covered_services ─────────────────────────────────────────
-- For service rows linked to a smart-skipped canonical, prefer canonical's existing
-- field_provenance if populated, else synthesize canonical_inherited entries.
-- Avoids overwriting any existing provenance (defensive; field_provenance='{}' guard).
WITH smart_skip_plan_covered AS (
  SELECT DISTINCT pcs.id, cps.field_provenance AS canonical_field_provenance
  FROM plan_covered_services pcs
  JOIN insurance_plans ip ON ip.id = pcs.insurance_plan_id
  JOIN documents d ON d.id = ip.source_document_id
  JOIN document_extraction_log del ON del.document_id = d.id
  LEFT JOIN canonical_plan_services cps
    ON cps.canonical_plan_id = ip.canonical_plan_id
    AND cps.service_slug = (
      SELECT slug FROM service_catalog WHERE id = pcs.service_id LIMIT 1
    )
  WHERE ip.canonical_plan_id IS NOT NULL
    AND pcs.field_provenance = '{}'::jsonb
    AND del.action = 'skipped_canonical_stable'
)
UPDATE plan_covered_services pcs
  SET field_provenance = COALESCE(
    -- Prefer canonical's field_provenance if non-empty
    NULLIF(ssp.canonical_field_provenance, '{}'::jsonb),
    -- Else synthesize canonical_inherited entries for populated columns
    jsonb_strip_nulls(
      jsonb_build_object(
        'in_copay', CASE WHEN pcs.in_copay IS NOT NULL THEN
          jsonb_build_object(
            'source', 'canonical_inherited',
            'confidence', 0.5,
            'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ELSE NULL END,
        'in_coinsurance', CASE WHEN pcs.in_coinsurance IS NOT NULL THEN
          jsonb_build_object(
            'source', 'canonical_inherited',
            'confidence', 0.5,
            'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ELSE NULL END,
        'in_deductible_applies', CASE WHEN pcs.in_deductible_applies IS NOT NULL THEN
          jsonb_build_object(
            'source', 'canonical_inherited',
            'confidence', 0.5,
            'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ELSE NULL END,
        'covered', CASE WHEN pcs.covered IS NOT NULL THEN
          jsonb_build_object(
            'source', 'canonical_inherited',
            'confidence', 0.5,
            'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ELSE NULL END,
        'prior_auth_required', CASE WHEN pcs.prior_auth_required IS NOT NULL THEN
          jsonb_build_object(
            'source', 'canonical_inherited',
            'confidence', 0.5,
            'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ELSE NULL END,
        'annual_limit_value', CASE WHEN pcs.annual_limit_value IS NOT NULL THEN
          jsonb_build_object(
            'source', 'canonical_inherited',
            'confidence', 0.5,
            'last_corroborated_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ELSE NULL END
      )
    ),
    '{}'::jsonb
  )
  FROM smart_skip_plan_covered ssp
  WHERE pcs.id = ssp.id;
