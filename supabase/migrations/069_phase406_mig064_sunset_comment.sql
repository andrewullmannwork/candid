-- Migration 069: Phase 4.0.6 Task 4.0.6-I — mig 064 RPC supersession comment.
--
-- Session 61 cleanup PR. Phase 4.0.6 architectural correction (Sessions 58-60)
-- replaced the mig 064 RPC value-write code path with a Pattern 1 #14-correct
-- canonical promotion event mechanism (mig 068 functions
-- `evaluate_pattern1_corroboration` + `apply_promotion_event`, called via the
-- TS helper `commitUploadAndEvaluateCorroboration` in
-- src/lib/parser/commit-and-evaluate.ts).
--
-- The mig 064 SQL function `upsert_canonical_services_with_merge` is no longer
-- invoked from production code (TS wrapper at src/lib/parser/canonical-merge.ts
-- deleted Session 61). Per Pattern 1 #10 hard-delete prohibition, the function
-- itself is retained as a superseded artifact; this migration only updates the
-- COMMENT to document its status. No runtime behavior change.
--
-- See also:
--   - Candid_Data_Principles.md §2 "Current implementation drift (mig 064 RPC)
--     and correction plan"
--   - Candid_Data_Patterns.md Pattern 1 #14 (user-initiated writes user-scoped
--     only; canonical via explicit promotion)
--   - plans/phase_4.0.6_canonical_promotion_event.md Q-P4.0.6-8 LOCK v4 (A)
--   - supabase/migrations/068_canonical_promotion_event_infrastructure.sql

BEGIN;

COMMENT ON FUNCTION upsert_canonical_services_with_merge(uuid, jsonb) IS
  'SUPERSEDED 2026-05-04 (Phase 4.0.6 Task 4.0.6-I, Session 61). Originally Bundle PR #1 (Session 55, audit item #13): atomic upsert with field_provenance shallow-merge per Pattern P-8 contract; pg_advisory_xact_lock per canonical_plan_id serializes concurrent writers. Replaced by mig 068 apply_promotion_event() which enforces Pattern 1 #14 (canonical population via explicit promotion event ONLY when Pattern 1 #3 corroboration threshold met) with finer-grained lock per (canonical_plan_id, service_slug, field_name). Function retained per Pattern 1 #10 hard-delete prohibition; no production callers remain. Do NOT add new callers — route writes through src/lib/parser/commit-and-evaluate.ts:commitUploadAndEvaluateCorroboration helper (Q-P4.0.6-1 LOCK v4; Engineering North Star #1 single code path).';

COMMIT;
