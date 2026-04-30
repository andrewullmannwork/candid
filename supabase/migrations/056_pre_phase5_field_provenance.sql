-- Migration 056: per-field source provenance + confidence storage (DR-3B locked decisions Q-DR-3B-1 through Q-DR-3B-5).
-- Per plans/phase_3_parse_strategy_refactor.md §Migration list "055-pre-phase5-2".
-- Phase 5 will normalize this JSONB into per-column provenance tables; Phase 3 ships
-- the JSONB shape for parser writes + downstream consumer migration path.
-- Additive schema; no rollback needed. Defaults are empty object so existing reads are unaffected.
--
-- Trigger: per Q-DR-3B-4, recompute the row-level `confidence` column as MIN over
-- per-field confidence values whenever field_provenance is written. Skips system
-- keys (anything starting with "_") so callers can stash metadata like `_meta_warnings`
-- without polluting the MIN calculation. No-ops when field_provenance is empty so
-- existing rows keep their original confidence values.
--
-- claim_line_items has NO row-level confidence column today (per Q-DR-3B-2 reasoning:
-- transactional tables don't use a row aggregate). Trigger only fires on tables that
-- already have a row-level `confidence` column: canonical_plan_services + plan_covered_services.

ALTER TABLE canonical_plan_services
  ADD COLUMN IF NOT EXISTS field_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE plan_covered_services
  ADD COLUMN IF NOT EXISTS field_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE claim_line_items
  ADD COLUMN IF NOT EXISTS field_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN canonical_plan_services.field_provenance IS
  'DR-3B per-field confidence + source provenance. Shape: {<field_name>: {source, confidence, last_corroborated_at, haiku_confidence?}}. Phase 4 consumers read via JSONB queries; Phase 5 promotes to columns. See plans/findings/dr3d_dogfood_findings.md.';

COMMENT ON COLUMN plan_covered_services.field_provenance IS
  'DR-3B per-field confidence + source provenance. See canonical_plan_services.field_provenance.';

COMMENT ON COLUMN claim_line_items.field_provenance IS
  'DR-3B per-field confidence + source provenance for parser-extracted bill/EOB line items. Phase 5 normalizes into columns.';

-- Per Q-DR-3B-4: BEFORE-trigger recomputes row-level confidence = MIN over categorized
-- field confidence values. The application is responsible for only writing categorized
-- fields into field_provenance (per Q-DR-3A-6 FIELD_CATEGORIES filter). This trigger
-- is defense-in-depth: if non-numeric or system-prefixed keys sneak in, they're skipped.
CREATE OR REPLACE FUNCTION recompute_row_confidence_from_provenance()
RETURNS TRIGGER AS $$
DECLARE
  min_conf NUMERIC;
BEGIN
  -- No-op when field_provenance is empty (preserves seeded confidence on existing rows).
  IF NEW.field_provenance IS NULL OR NEW.field_provenance = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  -- No-op when field_provenance hasn't changed (avoids gratuitous confidence rewrites
  -- on UPDATEs that touch other columns).
  IF TG_OP = 'UPDATE' AND NEW.field_provenance IS NOT DISTINCT FROM OLD.field_provenance THEN
    RETURN NEW;
  END IF;

  -- MIN over numeric confidence values, excluding system keys (prefix "_") and
  -- non-numeric values (defense against malformed JSONB writes).
  SELECT MIN((value->>'confidence')::numeric)
  INTO min_conf
  FROM jsonb_each(NEW.field_provenance) AS entries(key, value)
  WHERE key NOT LIKE '\_%' ESCAPE '\'
    AND value ? 'confidence'
    AND jsonb_typeof(value->'confidence') = 'number';

  -- Only update row.confidence if we actually computed a MIN; preserves existing
  -- value when field_provenance contains only system keys. Clamp to [0,1] so a
  -- buggy app write can never violate the table's CHECK constraint and block
  -- the INSERT/UPDATE entirely (defense-in-depth; SOURCE_DEFAULT_CONFIDENCE
  -- in field-categories.ts only produces values in [0,1] in practice).
  IF min_conf IS NOT NULL THEN
    NEW.confidence := GREATEST(0::numeric, LEAST(1::numeric, min_conf));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_plan_services_confidence_recompute ON canonical_plan_services;
CREATE TRIGGER canonical_plan_services_confidence_recompute
  BEFORE INSERT OR UPDATE ON canonical_plan_services
  FOR EACH ROW
  EXECUTE FUNCTION recompute_row_confidence_from_provenance();

DROP TRIGGER IF EXISTS plan_covered_services_confidence_recompute ON plan_covered_services;
CREATE TRIGGER plan_covered_services_confidence_recompute
  BEFORE INSERT OR UPDATE ON plan_covered_services
  FOR EACH ROW
  EXECUTE FUNCTION recompute_row_confidence_from_provenance();

-- Per Q-DR-3B-5: GIN index on field_provenance is DEFERRED to Phase 4 (when consumer
-- query patterns emerge and indexes can be designed against actual usage). Recommended
-- starting point at that time: GIN with jsonb_path_ops operator class for containment.
