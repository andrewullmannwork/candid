-- Migration 195: cold-start regen — add plan_tier_label to plan_covered_services + RE-KEY its UNIQUE to include
-- it (the user-scoped twin of mig 194's canonical re-key). (S258, Group B dup-key fix.)
--
-- WHY: the dup-key collapse happens at BOTH layers. plan_covered_services is keyed
-- (insurance_plan_id, service_id, place_of_service, component) (mig 157) — so two distinct drug cost-share
-- buckets for the same service (generic Preferred vs Non-Preferred; Tier 1 vs Tier 2; Condition-Care vs
-- All-Other) collapse on the pcs UPSERT (last-writer-wins) BEFORE they ever reach the canonical promotion. The
-- persisted user rows ARE the promotion's source (expandPerServiceCandidates reads pcs; persist-then-promote,
-- Rule #10) → if pcs collapses, canonical can never see the lost buckets. So pcs needs the SAME plan_tier_label
-- key dimension as canonical_plan_services (mig 194). One axis, Pattern S / Hard Rule #17 (plan-local bucket).
--
-- BACKWARD COMPAT: plan_tier_label DEFAULTs 'none' (NOT NULL). Every existing pcs row becomes 'none', so the
-- 5-col key is EXACTLY as unique as the old 4-col key for existing data → ZERO collisions on apply. The single
-- pcs writer constant PLAN_COVERED_ONCONFLICT (coverage-targeting.ts) flips to the 5-col target in lockstep
-- with this apply (a UNIQUE constraint cannot be flag-gated; pre-launch the upload window is controlled).
--
-- ROLLBACK (pre-launch, all rows 'none'):
--   ALTER TABLE plan_covered_services DROP CONSTRAINT IF EXISTS uq_plan_covered_service;
--   ALTER TABLE plan_covered_services ADD CONSTRAINT uq_plan_covered_service
--     UNIQUE (insurance_plan_id, service_id, place_of_service, component);
--   ALTER TABLE plan_covered_services DROP COLUMN IF EXISTS plan_tier_label;
--
-- STUDIO NOTE (reference_supabase_studio trap): apply via the Supabase CLI for atomicity (the re-key DROP+ADD
-- must be atomic). If you must use Studio, paste the statements BARE (no BEGIN/COMMIT) in order, then run VERIFY.

BEGIN;

-- ── 1. Add the plan_tier_label modifier column (mirrors canonical_plan_services mig 181 + the mig 194 widen) ──
ALTER TABLE plan_covered_services
  ADD COLUMN IF NOT EXISTS plan_tier_label TEXT NOT NULL DEFAULT 'none'
    CONSTRAINT plan_covered_services_plan_tier_label_check
    CHECK (plan_tier_label ~ '^[a-z][a-z0-9_]{0,39}$');

COMMENT ON COLUMN plan_covered_services.plan_tier_label IS
  'Plan-local drug cost-share BUCKET (Pattern S modifier, Hard Rule #17) — ''none'' or a normalized lowercase '
  'token (formulary ''tier_1''..''tier_12'' OR named program ''condition_care''/''all_other''/''preferred''/'
  '''non_preferred''/…). Part of uq_plan_covered_service (mig 195); the user-scoped twin of '
  'canonical_plan_services.plan_tier_label (mig 194). Plan-local, NOT cross-plan comparable.';

-- ── 2. RE-KEY uq_plan_covered_service to include plan_tier_label ──
ALTER TABLE plan_covered_services DROP CONSTRAINT IF EXISTS uq_plan_covered_service;
ALTER TABLE plan_covered_services
  ADD CONSTRAINT uq_plan_covered_service
  UNIQUE (insurance_plan_id, service_id, place_of_service, component, plan_tier_label);

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only; run AFTER apply):
--   1) column exists, NOT NULL, default 'none':
-- SELECT column_name, is_nullable, column_default FROM information_schema.columns
--   WHERE table_name='plan_covered_services' AND column_name='plan_tier_label';
--   2) the 5-col unique key (expect plan_tier_label present, ordinal 5):
-- SELECT a.attname, array_position(c.conkey, a.attnum) AS pos
-- FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
-- WHERE c.conname='uq_plan_covered_service' ORDER BY pos;
-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
