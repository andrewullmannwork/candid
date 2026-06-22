-- F.0 Phase-1 restore net — run FIRST on PROD, BEFORE mig 165. Pre-launch, cheap.
-- No DROP/IF NOT EXISTS on purpose: a second run errors loudly rather than silently
-- overwriting a good pre-migration snapshot with post-backfill state.
CREATE TABLE canonical_plan_services_pre_align_bak AS SELECT * FROM canonical_plan_services;
SELECT count(*) AS snapshot_rows FROM canonical_plan_services_pre_align_bak;  -- expect 48552
