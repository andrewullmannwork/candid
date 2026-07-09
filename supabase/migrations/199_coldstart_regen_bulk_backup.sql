-- Migration 199: cold-start regen — BULK pre-run backup of the two canonical tables (S272, Group B Stage-C Step 4).
--
-- WHY: Step 4 rewrites canonical_plan_services + canonical_plans for the ~1,225-plan clean set through the seed
-- harness (.scratch-regen/full-run.ts). The per-plan JSON snapshots (snapshot-full-<canonical>.json) are the
-- SURGICAL net (one plan restored net-zero, proven ×3 in Step 3). This mig is the NUCLEAR belt-and-suspenders:
-- a single whole-table, as-of-run-start copy so the entire canonical layer can be restored in one shot if the run
-- goes systemically wrong — independent of the JSON files. Follows the F.0 `_pre_align_bak` precedent (mig 165-era).
--
-- SCOPE: the two SHARED/flywheel-critical tables only. plan_covered_services is user-scoped (the admin's own seed
-- rows) and is fully covered per-plan by the JSON snapshots → deliberately NOT bulk-copied here.
--
-- ADDITIVE (Data-Architecture Rule #7): CREATE TABLE only; no ALTER/DROP of live tables; the live tables are
-- untouched by this mig. IF NOT EXISTS = a re-apply is a no-op that PRESERVES the first (true pre-regen) copy.
--
-- LIFECYCLE (Ship-Gate G5): these bak tables are EPHEMERAL. Drop them once the Step-4 run is validated + the PR
-- merges (a follow-up one-liner mig or manual DROP). They are locked to service_role (RLS-on, no policy) so they
-- never leak canonical data to anon/authenticated while they exist.
--
-- ROLLBACK (of THIS mig):
--   DROP TABLE IF EXISTS public.canonical_plan_services_pre_regen_bak;
--   DROP TABLE IF EXISTS public.canonical_plans_pre_regen_bak;
--
-- RESTORE-FROM-BAK (only if the whole run must be reverted — the nuclear option; prefer per-plan JSON rollback):
--   the two BEFORE triggers on canonical_plan_services (mig 169 align-mirror + mig 056 confidence) are
--   deterministic functions of each row's own columns → a verbatim reinsert recomputes identical derived columns.
--   TRUNCATE public.canonical_plan_services; INSERT INTO public.canonical_plan_services SELECT * FROM public.canonical_plan_services_pre_regen_bak;
--   -- canonical_plans has inbound FKs (cannot TRUNCATE); restore via UPDATE…FROM the bak on the changed rows,
--   -- or per-plan JSON rollback. Coordinate — canonical is a shared table.
--
-- STUDIO NOTE (reference_supabase_studio_migration_apply — Studio can report success while applying nothing on a
-- wrapped/commented paste): these are 6 independent, schema-qualified statements — apply via the Supabase CLI, OR
-- paste them BARE (comment-free) in Studio in order, THEN run the VERIFY block and confirm the bak counts equal
-- the live counts. Not wrapped in BEGIN/COMMIT (each statement is independent; no cross-statement atomicity needed).

CREATE TABLE IF NOT EXISTS public.canonical_plans_pre_regen_bak AS
  SELECT * FROM public.canonical_plans;

CREATE TABLE IF NOT EXISTS public.canonical_plan_services_pre_regen_bak AS
  SELECT * FROM public.canonical_plan_services;

ALTER TABLE public.canonical_plans_pre_regen_bak ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_plan_services_pre_regen_bak ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.canonical_plans_pre_regen_bak FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.canonical_plan_services_pre_regen_bak FROM PUBLIC, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only; run AFTER apply — bak counts MUST equal live counts at run-start):
-- SELECT
--   (SELECT count(*) FROM public.canonical_plans)                      AS live_canonical_plans,
--   (SELECT count(*) FROM public.canonical_plans_pre_regen_bak)        AS bak_canonical_plans,
--   (SELECT count(*) FROM public.canonical_plan_services)              AS live_canonical_plan_services,
--   (SELECT count(*) FROM public.canonical_plan_services_pre_regen_bak) AS bak_canonical_plan_services;
-- -- expect live_* == bak_* (e.g. ~1,314 plans / ~48,552 services).
-- Lockdown check (expect NO anon/authenticated rows):
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--   WHERE table_name IN ('canonical_plans_pre_regen_bak','canonical_plan_services_pre_regen_bak')
--     AND grantee IN ('anon','authenticated') ORDER BY 1;
-- ───────────────────────────────────────────────────────────────────────────────────────────────────────
