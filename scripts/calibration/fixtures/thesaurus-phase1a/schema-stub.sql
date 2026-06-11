-- Phase 1a T1 fixture — minimal stub schema.
-- Only the tables/columns evaluate_pattern1_corroboration (mig 156) reads, so the
-- function's logic can be exercised calibration-independently (no PROD, no full 155-mig
-- replay). Column shapes mirror the real schema (verified: migs 009/108/147); the parse +
-- column-ref correctness against the REAL tables is covered separately by applying mig 156
-- to this stub (Postgres validates plpgsql bodies at CREATE).
-- Deliberately OMITS plan_covered_services.component so mig 156 PART A's ADD COLUMN runs here too.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE feature_flag_rules (
  flag_key    TEXT PRIMARY KEY,
  enabled     BOOLEAN,
  description TEXT,
  target_type TEXT,
  config      JSONB
);

CREATE TABLE service_catalog (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  TEXT,
  concept_id            UUID,
  canonical_for_concept BOOLEAN
);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_verified BOOLEAN,
  phone_verified BOOLEAN
);

CREATE TABLE canonical_plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_provenance JSONB
);

CREATE TABLE insurance_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID,
  canonical_plan_id UUID,
  field_provenance  JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE plan_covered_services (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurance_plan_id UUID,
  service_id        UUID,
  place_of_service  TEXT DEFAULT 'any',
  field_provenance  JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE canonical_plan_services (
  canonical_plan_id UUID,
  service_slug      TEXT,
  place_of_service  TEXT DEFAULT 'any',
  component         TEXT DEFAULT 'global',
  field_provenance  JSONB
);
