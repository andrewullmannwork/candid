-- Migration 200 — track admin_audit_log (schema-drift remediation)
--
-- WHY: admin_audit_log already exists in PROD but was NEVER a tracked migration —
-- it was created ad-hoc by the (now-deleted, S273) POST /api/admin/setup-audit-log
-- route via an exec_sql RPC. This migration records the exact live schema so the
-- table stops being schema drift, and adds the grant lockdown the ad-hoc create
-- omitted.
--
-- IDEMPOTENT: every CREATE ... IF NOT EXISTS is a no-op against the already-present
-- table + indexes. The REVOKE is the one meaningful change (lock the audit trail to
-- service_role — rows are written ONLY server-side via logAdminAction()).
--
-- APPLY (Supabase Studio): paste the four statements below as BARE SQL — strip these
-- leading `--` comment lines (per the "success-but-nothing" Studio trap), the
-- statements are schema-qualified. Then run the two verify SELECTs at the bottom.

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_user_id UUID NOT NULL,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id UUID,
  target_table TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created ON public.admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON public.admin_audit_log(action);

REVOKE ALL ON public.admin_audit_log FROM anon, authenticated;

-- VERIFY (run after apply):
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'admin_audit_log'
--    ORDER BY ordinal_position;   -- expect the 9 columns above
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'admin_audit_log';   -- expect NO anon / authenticated rows
