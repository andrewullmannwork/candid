-- Migration 190: Secure public.claim_line_items_aggregate (SECURITY DEFINER view leak fix)
--
-- WHY (CONFIRMED LIVE LEAK): claim_line_items_aggregate is a view owned by the postgres
--   superuser, so as a non-security_invoker view it BYPASSES the row-level security on its base
--   table claim_line_items, and Supabase's default privilege grants anon SELECT on public views.
--   Net effect, verified empirically against PROD with the public anon key: an ANONYMOUS caller
--   could read cross-user financial rows (billed_amount, allowed_amount, patient_owes, concept_id,
--   service_slug, billing_code) — 17 rows at time of discovery. The base table is RLS-protected
--   (anon count = 0); the VIEW is the only hole. Also clears the Supabase "Security Definer View"
--   advisor on this entity.
--
-- WHAT:
--   1. Revoke all access from PUBLIC / anon / authenticated.
--   2. Grant SELECT only to service_role — the view's only intended consumers are backend
--      aggregate jobs (Care / Mestimate / data exports, per mig 058); NO application code reads it
--      today (grep: a single stale code comment), so this breaks nothing.
--   3. security_invoker = true — the base table's RLS now applies through the view (defense in
--      depth: even a stray grant returns 0 rows to a non-owner). service_role bypasses RLS, so the
--      backend aggregate consumers are unaffected.
--
-- ROLLOUT: Studio-apply; no app deploy needed (zero current readers). Requires PG15+ (Supabase
--   default) for security_invoker — the leak is closed by the REVOKE alone regardless of version.
-- ROLLBACK (re-opens the leak — only if a regression surfaces):
--   GRANT SELECT ON public.claim_line_items_aggregate TO anon, authenticated;
--   ALTER VIEW public.claim_line_items_aggregate RESET (security_invoker);

REVOKE ALL ON public.claim_line_items_aggregate FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.claim_line_items_aggregate TO service_role;
ALTER VIEW public.claim_line_items_aggregate SET (security_invoker = true);
