-- Self-contained model of canonical_plan_services for the F.0 Phase-1 fixture.
-- Faithfully mirrors the real table's relevant columns + DEFAULTs (verified S207) AND the
-- mig-056 confidence-recompute trigger, so the fixture proves mig 165 + backfill against a
-- realistic stand-in without touching PROD. (Independence: the fixture seeds its own GT.)

CREATE TABLE canonical_plan_services (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id   UUID,
  service_slug        TEXT,
  place_of_service    TEXT DEFAULT 'any',
  component           TEXT DEFAULT 'global',
  -- legacy in-network coverage columns (pre in_/out_ convention) + real DEFAULTs
  copay               NUMERIC,
  coinsurance         NUMERIC,
  deductible_applies  BOOLEAN DEFAULT true,
  is_covered          BOOLEAN DEFAULT true,
  requires_prior_auth BOOLEAN DEFAULT false,
  -- out_* already match the convention (present for realism; untouched by F.0)
  out_copay           NUMERIC,
  confidence          NUMERIC DEFAULT 0.5,
  field_provenance    JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- mig-056 confidence-recompute trigger: confidence = MIN(non-'_' provenance keys' confidence)
-- whenever field_provenance changes; no-op on empty/unchanged. F.0 must not perturb it.
CREATE OR REPLACE FUNCTION recompute_row_confidence_from_provenance()
RETURNS TRIGGER AS $$
DECLARE min_conf NUMERIC;
BEGIN
  IF NEW.field_provenance IS NULL OR NEW.field_provenance = '{}'::jsonb THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.field_provenance IS NOT DISTINCT FROM OLD.field_provenance THEN RETURN NEW; END IF;
  SELECT MIN((value->>'confidence')::numeric) INTO min_conf
  FROM jsonb_each(NEW.field_provenance) AS entries(key, value)
  WHERE key NOT LIKE '\_%' ESCAPE '\'
    AND value ? 'confidence'
    AND jsonb_typeof(value->'confidence') = 'number';
  IF min_conf IS NOT NULL THEN NEW.confidence := GREATEST(0::numeric, LEAST(1::numeric, min_conf)); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canonical_plan_services_confidence_recompute ON canonical_plan_services;
CREATE TRIGGER canonical_plan_services_confidence_recompute
  BEFORE INSERT OR UPDATE ON canonical_plan_services
  FOR EACH ROW EXECUTE FUNCTION recompute_row_confidence_from_provenance();
