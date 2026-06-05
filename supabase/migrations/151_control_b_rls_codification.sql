-- 151_control_b_rls_codification.sql
-- control-B (S168) — codify deny-by-default RLS for user-scoped / PII tables into version control.
--
-- WHY: An anon-key audit (the public NEXT_PUBLIC_SUPABASE_ANON_KEY) reads 0 rows from every
-- user-scoped table — RLS is behaviorally active (no live exposure). But for the 15 tables below
-- the RLS lives only in dashboard/base-schema state with NO version-controlled statement, so a
-- fresh DB rebuild from migrations would NOT reproduce the protection, and there is no artifact
-- to prove the posture for the OPS.8 counsel review.
--
-- WHAT: idempotent ENABLE ROW LEVEL SECURITY (deny-by-default — RLS-enabled with NO policy =>
-- anon & authenticated read 0 rows; service_role bypasses RLS for the server/API path) + an
-- explicit service_role grant so access is reproducible from migrations alone.
--
-- BEHAVIOR CHANGE: NONE. Every table already denies anon (verified: anon count=0 on tables
-- holding up to 275 rows). This is a pure codification of the existing posture — idempotent,
-- re-runnable, atomic.
--
-- DELIBERATELY OMITTED — REVOKE ... FROM anon/authenticated (the mig-144 pattern):
--   anon already gets 0 rows via RLS, so REVOKE adds NO security here; it would only flip anon's
--   failure mode empty->error (risking any client-bundled anon read, e.g. insurer_catalog) and
--   would clobber the existing `TO authenticated` grant on service_catalog_admin_review_queue.
--   mig 144's REVOKE was correct for a service-role-ONLY table; copying it onto user-data /
--   reference tables is a context mismatch. REVOKE + default-privilege hardening are deferred to
--   an audited follow-up (client-anon-read call-graph), not bundled blindly.
--
-- Table set derived SYSTEMATICALLY (user-scoped tables [user_id/firebase_uid column] MINUS tables
-- already RLS-enabled in migrations), not hand-picked. The companion anon-probe audit script
-- (scripts/security/rls-anon-audit.ts) is the reproducible completeness proof + anti-regression check.
--
-- Rollback: ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;  (per table — reverts to prior dashboard state)

BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'benefit_corrections',
    'bill_parser_decisions',
    'canonical_correction_challenges',
    'canonical_divergence_review',
    'canonical_document_stability',
    'claim_discrepancies',
    'claims',
    'dispute_followups',
    'dispute_outcomes',
    'haiku_spend_tracking',
    'insurer_appeals_confirmations',
    'insurer_appeals_proposed_changes',
    'insurer_catalog',
    'parse_cost_events',
    'service_catalog_admin_review_queue'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
      EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
      RAISE NOTICE 'control-B: RLS codified on %', t;
    ELSE
      RAISE NOTICE 'control-B: table % not found, skipped', t;
    END IF;
  END LOOP;
END $$;

COMMIT;
