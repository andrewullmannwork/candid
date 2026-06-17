-- Erasure write guard fixture (mig 166) — minimal stub schema.
-- Only the tables/columns mig 166 touches, so the trigger + function logic can be
-- exercised calibration-independently (no PROD, no full migration replay).
-- Deliberately OMITS users.chd_erased_at so mig 166's ADD COLUMN runs here too.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE feature_flag_rules (
  flag_key    TEXT PRIMARY KEY,
  enabled     BOOLEAN,
  description TEXT,
  target_type TEXT,
  config      JSONB
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

-- The three user-CHD insert-target tables the guard fires on (minimal shape).
CREATE TABLE insurance_plans (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID
);

CREATE TABLE claims (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID
);

CREATE TABLE canonical_haiku_extractions (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID
);
