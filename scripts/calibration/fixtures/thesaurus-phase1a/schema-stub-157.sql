-- Phase 1a mig-157 fixture — minimal stub schema.
-- Reproduces just enough for migration 157 to run + be asserted, calibration-independently:
--   • plan_covered_services WITH the mig-009 INLINE (auto-named) 3-col UNIQUE — so PART A's
--     name-agnostic discover+drop has a real target — PLUS the mig-156 `component` column.
--   • benefit_corrections stub — so PART B's ADD COLUMN runs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE plan_covered_services (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurance_plan_id UUID,
  service_id        UUID,
  place_of_service  TEXT NOT NULL DEFAULT 'any',
  component         TEXT NOT NULL DEFAULT 'global'
    CHECK (component IN ('facility','professional','global')),   -- mig 156 PART A (already PROD-applied)
  UNIQUE (insurance_plan_id, service_id, place_of_service)        -- mig 009 inline, auto-named
);

CREATE TABLE benefit_corrections (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field TEXT
);

-- PART C — tables apply_promotion_event reads/writes, so the reproduced function (mig 157 PART C)
-- can be exercised (plpgsql validates column refs at CALL, not CREATE → the assertions must call it).
CREATE TABLE feature_flag_rules (
  flag_key TEXT PRIMARY KEY,
  config   JSONB
);

CREATE TABLE canonical_plans (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_provenance      JSONB,
  deductible_individual NUMERIC, deductible_family NUMERIC,
  oop_max_individual    NUMERIC, oop_max_family NUMERIC,
  plan_name TEXT, plan_year INT, plan_type TEXT, metal_level TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE canonical_plan_services (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id  UUID,
  service_slug       TEXT,
  place_of_service   TEXT DEFAULT 'any',
  component          TEXT DEFAULT 'global',
  copay NUMERIC, coinsurance NUMERIC, is_covered BOOLEAN, requires_prior_auth BOOLEAN,
  deductible_applies BOOLEAN, annual_limit INTEGER,
  confidence NUMERIC, source TEXT, field_provenance JSONB,
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_canonical_plan_service UNIQUE (canonical_plan_id, service_slug, place_of_service, component)
);

CREATE TABLE canonical_promotion_events (
  id                 UUID PRIMARY KEY,
  canonical_plan_id  UUID, service_slug TEXT, place_of_service TEXT, component TEXT,
  field_name TEXT, event_type TEXT, fire_source TEXT,
  corroborator_count INT, sources_count INT, corroborated_value JSONB,
  actor_user_id UUID, fired_at TIMESTAMPTZ DEFAULT now()
);
