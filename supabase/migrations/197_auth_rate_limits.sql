-- Migration 197: auth_rate_limits — durable, distributed login rate-limit + progressive lockout
--
-- WHY (B9-2 Parts 3-4): the current limiter (src/lib/security/rate-limit.ts) is in-memory
-- and per-lambda-instance, so on Vercel serverless it does not actually bound an attacker who
-- spreads attempts across instances / cold starts. This replaces the backing store with a
-- shared Postgres table so the limit holds across every instance. It backs:
--   - /api/auth/admin-password       (NEW: rate-limit + progressive per-IP lockout)
--   - /api/auth/reset-password       (migrated off the in-memory limiter)
--   - /api/auth/resend-verification  (migrated off the in-memory limiter)
--
-- ADDITIVE ONLY — new table + 3 functions + 1 flag row, no ALTER/DROP of existing objects
-- (Data Rule #7). Re-runnable (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING).
--
-- SECURITY: functions are SECURITY INVOKER (not DEFINER) — only service_role (BYPASSRLS)
-- calls them, so INVOKER is sufficient AND fail-safe: if the Supabase default EXECUTE grant to
-- anon/authenticated ever slips past the REVOKE below, an invoker-context call is denied by RLS
-- (no policies) instead of running with owner privilege. Belt: RLS on + REVOKE + service_role GRANT.
--
-- THRESHOLDS ARE NOT BAKED HERE: callers pass window/max/lockout params from flag
-- `admin_login_hardening_v1` config (with safe hardcoded fallbacks in code), so this SQL stays
-- generic + tunable and the protection is always-on (fail-safe), never flag-gated OFF.
--
-- FOLLOW-UP (non-blocking): buckets self-reset each window but rows are not physically pruned;
-- add a daily prune (DELETE WHERE updated_at < now() - interval '1 day') to an existing cron if
-- the table ever grows. Pre-launch admin/reset/resend volume makes this negligible.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.clear_login_rate_limit(text);
--   DROP FUNCTION IF EXISTS public.register_login_failure(text,integer,integer,timestamptz);
--   DROP FUNCTION IF EXISTS public.consume_login_rate_limit(text,integer,integer,timestamptz);
--   DROP TABLE IF EXISTS public.auth_rate_limits;
--   (flag row: leave, or DELETE FROM feature_flag_rules WHERE flag_key='admin_login_hardening_v1';)

CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  bucket_key         text        PRIMARY KEY,   -- e.g. 'admin-pw:ip:<addr>', 'reset-pw:ip:<addr>'
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  attempt_count      integer     NOT NULL DEFAULT 0,
  failure_count      integer     NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Supports periodic pruning of stale buckets (see FOLLOW-UP above).
CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_at_idx
  ON public.auth_rate_limits (updated_at);

-- Deny-by-default. No user ever touches this table; only service_role (which bypasses RLS).
ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;

-- ───────────────────────────────────────────────────────────────────────────────────────
-- consume_login_rate_limit(bucket, window_s, max_attempts, now)
--   Atomic PRE-attempt gate (single upsert — no read-then-write race). Rolls the fixed window,
--   honors an ACTIVE lockout, and counts this attempt. "Reset to a fresh bucket" when the window
--   has rolled OR a prior lockout has already EXPIRED — so a served-out lockout returns a FULL
--   attempt budget instead of re-locking on the next single failure. Returns allow + retry-after.
-- ───────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.consume_login_rate_limit(
  p_bucket_key     text,
  p_window_seconds integer,
  p_max_attempts   integer,
  p_now            timestamptz DEFAULT now()
) RETURNS TABLE (allowed boolean, retry_after_seconds integer, locked_until timestamptz)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_window_start timestamptz;
  v_attempts     integer;
  v_locked_until timestamptz;
BEGIN
  INSERT INTO public.auth_rate_limits AS a (bucket_key, window_started_at, attempt_count, updated_at)
  VALUES (p_bucket_key, p_now, 1, p_now)
  ON CONFLICT (bucket_key) DO UPDATE SET
    -- reset condition (repeated per column; = window rolled OR lockout expired):
    window_started_at = CASE WHEN a.window_started_at + make_interval(secs => p_window_seconds) < p_now
                               OR (a.locked_until IS NOT NULL AND a.locked_until <= p_now)
                          THEN p_now ELSE a.window_started_at END,
    attempt_count     = CASE WHEN a.window_started_at + make_interval(secs => p_window_seconds) < p_now
                               OR (a.locked_until IS NOT NULL AND a.locked_until <= p_now)
                          THEN 1 ELSE a.attempt_count + 1 END,
    failure_count     = CASE WHEN a.window_started_at + make_interval(secs => p_window_seconds) < p_now
                               OR (a.locked_until IS NOT NULL AND a.locked_until <= p_now)
                          THEN 0 ELSE a.failure_count END,
    locked_until      = CASE WHEN a.window_started_at + make_interval(secs => p_window_seconds) < p_now
                               OR (a.locked_until IS NOT NULL AND a.locked_until <= p_now)
                          THEN NULL ELSE a.locked_until END,
    updated_at        = p_now
  RETURNING a.window_started_at, a.attempt_count, a.locked_until
    INTO v_window_start, v_attempts, v_locked_until;

  -- Active lockout wins over everything.
  IF v_locked_until IS NOT NULL AND v_locked_until > p_now THEN
    RETURN QUERY SELECT false,
      CEIL(EXTRACT(EPOCH FROM (v_locked_until - p_now)))::integer,
      v_locked_until;
    RETURN;
  END IF;

  -- Over the per-window attempt cap.
  IF v_attempts > p_max_attempts THEN
    RETURN QUERY SELECT false,
      CEIL(EXTRACT(EPOCH FROM (v_window_start + make_interval(secs => p_window_seconds) - p_now)))::integer,
      NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, 0, NULL::timestamptz;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────────────────
-- register_login_failure(bucket, lockout_threshold, lockout_s, now)
--   POST-attempt, on a FAILED credential check. Increments the consecutive-failure counter
--   and, once it crosses the threshold, sets a lockout window. Returns the new locked_until
--   (NULL if not yet locked). Per-IP by construction — cannot lock out the real admin's IP.
-- ───────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_login_failure(
  p_bucket_key        text,
  p_lockout_threshold integer,
  p_lockout_seconds   integer,
  p_now               timestamptz DEFAULT now()
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_failures integer;
  v_locked   timestamptz;
BEGIN
  INSERT INTO public.auth_rate_limits (bucket_key, failure_count, updated_at)
  VALUES (p_bucket_key, 1, p_now)
  ON CONFLICT (bucket_key) DO UPDATE
    SET failure_count = auth_rate_limits.failure_count + 1,
        updated_at    = p_now
  RETURNING failure_count INTO v_failures;

  IF v_failures >= p_lockout_threshold THEN
    v_locked := p_now + make_interval(secs => p_lockout_seconds);
    UPDATE public.auth_rate_limits
      SET locked_until = v_locked, updated_at = p_now
      WHERE bucket_key = p_bucket_key;
  END IF;

  RETURN v_locked;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────────────────
-- clear_login_rate_limit(bucket) — POST-attempt, on SUCCESS. Resets the bucket entirely.
-- ───────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.clear_login_rate_limit(p_bucket_key text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  DELETE FROM public.auth_rate_limits WHERE bucket_key = p_bucket_key;
$$;

-- Lock execution to service_role only. Supabase auto-grants EXECUTE to anon/authenticated on
-- new public functions, so REVOKE first, then GRANT (per the default-privileges rule).
REVOKE ALL ON FUNCTION public.consume_login_rate_limit(text,integer,integer,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_login_failure(text,integer,integer,timestamptz)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_login_rate_limit(text)                               FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_login_rate_limit(text,integer,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_login_failure(text,integer,integer,timestamptz)   TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_login_rate_limit(text)                               TO service_role;

-- ───────────────────────────────────────────────────────────────────────────────────────
-- Tuning flag: admin_login_hardening_v1
--   NOT a gate — the rate-limit + lockout ALWAYS run with the safe hardcoded fallbacks in
--   code (fail-safe: a missing/OFF/erroring flag row never disables brute-force protection).
--   The `config` JSONB only OVERRIDES those thresholds (code clamps to sane minimums so a
--   fat-fingered config can't lock everyone out), and `turnstile_required` is the emergency
--   escape to drop the admin-login Turnstile requirement WITHOUT a deploy. Seeded enabled=true.
--   Defaults below == the code fallbacks (admin login: 10 attempts / 15 min window; lock after
--   5 consecutive failures for 15 min; Turnstile required).
-- ───────────────────────────────────────────────────────────────────────────────────────
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'admin_login_hardening_v1',
  true,
  'B9-2 Parts 3-4. Tunes (does NOT gate) the durable login rate-limit + progressive per-IP lockout on /api/auth/admin-password (also backs reset-password + resend-verification via the shared durable limiter). Protection is always-on with safe code fallbacks — a missing/OFF row never disables it. config overrides thresholds (clamped to safe minimums); turnstile_required=false drops the admin-login Turnstile requirement without a deploy (emergency escape).',
  'global',
  '{"window_seconds": 900, "max_attempts": 10, "lockout_threshold": 5, "lockout_seconds": 900, "turnstile_required": true}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
