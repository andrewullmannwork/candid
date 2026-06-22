-- F.0 Phase-2 FLYWHEEL A/B fixture — combined stub.
-- Models BOTH sides the corroboration evaluator crosses: the user side (verified users +
-- plan_covered_services, keyed by the aligned column name in_copay) AND the cold-start canonical
-- reference (canonical_plan_services, with the LEGACY typed columns so the REAL mig 165 + backfill +
-- mig 169 can run on it). The A/B then shows the evaluator's DECISION change pre vs post alignment.
-- User-side tables mirror scripts/calibration/fixtures/thesaurus-phase1a/schema-stub.sql; the canonical
-- table mirrors the richer canonical-field-align-p2 stub (legacy typed cols + confidence trigger).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE feature_flag_rules (
  flag_key TEXT PRIMARY KEY, enabled BOOLEAN, description TEXT, target_type TEXT, config JSONB
);
CREATE TABLE service_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT, concept_id UUID, canonical_for_concept BOOLEAN
);
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email_verified BOOLEAN, phone_verified BOOLEAN
);
CREATE TABLE canonical_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_provenance JSONB
);
CREATE TABLE insurance_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, canonical_plan_id UUID,
  field_provenance JSONB, created_at TIMESTAMPTZ DEFAULT now()
);
-- plan_covered_services DELIBERATELY omits `component` so mig 156 PART A's ADD COLUMN runs here too.
CREATE TABLE plan_covered_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), insurance_plan_id UUID, service_id UUID,
  place_of_service TEXT DEFAULT 'any', field_provenance JSONB, created_at TIMESTAMPTZ DEFAULT now()
);

-- Cold-start reference table: the RICHER shape so mig 165 (ADD aligned cols) + backfill + mig 169 apply.
CREATE TABLE canonical_plan_services (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id   UUID,
  service_slug        TEXT,
  place_of_service    TEXT DEFAULT 'any',
  component           TEXT DEFAULT 'global',
  copay               NUMERIC,
  coinsurance         NUMERIC,
  deductible_applies  BOOLEAN DEFAULT true,
  is_covered          BOOLEAN DEFAULT true,
  requires_prior_auth BOOLEAN DEFAULT false,
  annual_limit        INTEGER,
  out_copay           NUMERIC,
  out_coinsurance     NUMERIC,
  out_deductible_applies BOOLEAN,
  confidence          NUMERIC DEFAULT 0.5,
  source              TEXT,
  field_provenance    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (canonical_plan_id, service_slug, place_of_service, component)
);

-- mig-056 confidence-recompute trigger (so the alignment must not perturb confidence).
CREATE OR REPLACE FUNCTION recompute_row_confidence_from_provenance()
RETURNS TRIGGER AS $$
DECLARE min_conf NUMERIC;
BEGIN
  IF NEW.field_provenance IS NULL OR NEW.field_provenance = '{}'::jsonb THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.field_provenance IS NOT DISTINCT FROM OLD.field_provenance THEN RETURN NEW; END IF;
  SELECT MIN((value->>'confidence')::numeric) INTO min_conf
  FROM jsonb_each(NEW.field_provenance) AS entries(key, value)
  WHERE key NOT LIKE '\_%' ESCAPE '\' AND value ? 'confidence' AND jsonb_typeof(value->'confidence') = 'number';
  IF min_conf IS NOT NULL THEN NEW.confidence := GREATEST(0::numeric, LEAST(1::numeric, min_conf)); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS canonical_plan_services_confidence_recompute ON canonical_plan_services;
CREATE TRIGGER canonical_plan_services_confidence_recompute
  BEFORE INSERT OR UPDATE ON canonical_plan_services
  FOR EACH ROW EXECUTE FUNCTION recompute_row_confidence_from_provenance();
