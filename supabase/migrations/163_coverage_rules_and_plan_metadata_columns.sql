-- Migration 163: the two user-scoped JSONB stores the EOC writer needs (S195/S200)
--
-- ROOT CAUSE (found via the #197 de-swallow loud-failure): the EOC coverage +
-- plan-metadata write paths target columns that were never migrated onto the
-- user-scoped tables — latent dead-code drift (same class as mig 162), invisible
-- until #189 made the EOC parser reachable in PROD:
--   • plan_covered_services.coverage_rules — the per-cell JSONB the EOC coverage
--     writer merges into (src/lib/plan/coverage-targeting.ts upsertServiceCoverage:
--     "single sanctioned writer of EOC coverage_rules"). Mirror of
--     canonical_plan_services.coverage_rules (migs 019/064) on the user-scoped
--     side, per Data Rule #9 ("coverage_rules JSONB first, promote to column later").
--   • insurance_plans.metadata — the eoc_* section bag (eoc_prior_auth_facts[],
--     eoc_coverage_provisions[]; src/lib/plan/process-eoc.ts). Parallels
--     documents.metadata. The identity INSERT already succeeds (it carries
--     field_provenance, mig 063); only this metadata-bag UPDATE was rejected.
--
-- The #197 de-swallow surfaced both LOUD: documents.processing_error +
-- documents.metadata.eoc_parse_runlog.persist named each as
-- "Could not find the '<col>' column ... in the schema cache"
-- (coverage: 9 writes failed / 0 cells; metadata: persist.metadataError).
-- place_of_service was RULED OUT (an allowed value with 294 live rows).
--
-- APPLIED TO PROD via Supabase Studio (Andrew, 2026-06-13) — this file is the
-- committed record so a fresh-DB rebuild reproduces it. Re-running is a no-op
-- (ADD COLUMN IF NOT EXISTS).
--
-- ADDITIVE (Data Rule #7): new nullable JSONB columns, default '{}'; no existing
-- row can violate. coverage_rules mirrors canonical_plan_services.coverage_rules.
-- Rollback: DROP COLUMN IF EXISTS on each (safe pre-launch — no reader depends on
-- these yet; the EOC reader-resolution block E is not built).

BEGIN;

ALTER TABLE plan_covered_services
  ADD COLUMN IF NOT EXISTS coverage_rules JSONB DEFAULT '{}'::jsonb;

ALTER TABLE insurance_plans
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

COMMIT;
