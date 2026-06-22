-- Self-contained model for the F.0 Phase-2 fixture (mig 169).
-- Models canonical_plan_services with its LEGACY in-network columns + real DEFAULTs (pre-mig-165
-- state) + the mig-056 confidence-recompute trigger + the 4-col UNIQUE the promotion writer's
-- ON CONFLICT needs + the canonical_promotion_events event log + feature_flag_rules. The fixture
-- then applies mig 165 (adds aligned cols + Phase-1 one-directional mirror) THEN mig 169 (symmetric
-- mirror + drop-defaults + per-service flip) and asserts against this realistic stand-in — no PROD.

CREATE TABLE canonical_plan_services (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id   UUID,
  service_slug        TEXT,
  place_of_service    TEXT DEFAULT 'any',
  component           TEXT DEFAULT 'global',
  -- legacy in-network coverage columns (pre in_/out_ convention) + real DEFAULTs (verified S207)
  copay               NUMERIC,
  coinsurance         NUMERIC,
  deductible_applies  BOOLEAN DEFAULT true,
  is_covered          BOOLEAN DEFAULT true,
  requires_prior_auth BOOLEAN DEFAULT false,
  annual_limit        INTEGER,
  -- out_* already match the convention (present for realism; untouched by F.0)
  out_copay           NUMERIC,
  out_coinsurance     NUMERIC,
  out_deductible_applies BOOLEAN,
  confidence          NUMERIC DEFAULT 0.5,
  source              TEXT,
  field_provenance    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (canonical_plan_id, service_slug, place_of_service, component)
);

-- Event log the promotion writer appends to (minimal — matches the INSERT column list).
CREATE TABLE canonical_promotion_events (
  id                 UUID PRIMARY KEY,
  canonical_plan_id  UUID,
  service_slug       TEXT,
  place_of_service   TEXT,
  component          TEXT,
  field_name         TEXT,
  event_type         TEXT,
  fire_source        TEXT,
  corroborator_count INT,
  sources_count      INT,
  corroborated_value JSONB,
  actor_user_id      UUID,
  fired_at           TIMESTAMPTZ DEFAULT now()
);

-- Minimal feature_flag_rules (the writer reads sources_array_max_k; absent row -> COALESCE 5).
CREATE TABLE feature_flag_rules (
  flag_key TEXT PRIMARY KEY,
  config   JSONB DEFAULT '{}'::jsonb
);

-- mig-056 confidence-recompute trigger: confidence = MIN(non-'_' provenance keys' confidence)
-- whenever field_provenance changes; no-op on empty/unchanged. mig 169 must not perturb it
-- (the bidirectional twin carries identical confidence -> MIN unchanged).
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
