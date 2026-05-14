-- S74.6 D-cost §F.1 — Per-user-day Haiku spend tracking + atomic
-- reserve_haiku_spend RPC for the $10/user/day spend cap. S87 deferred
-- the spend-cap mechanism entirely; today's `reserve_haiku_budget` only
-- enforces a COUNT cap (calls/day), not a DOLLAR cap. Per parent Subplan §1
-- LOCK: pause + log + admin alert (NOT silent degradation).
--
-- Lifecycle:
--   1. Per-user row materializes on first Haiku call of the day (UPSERT inside
--      the RPC); cost accumulates as calls fire.
--   2. When cumulative cost would exceed the effective cap, RPC sets
--      paused_at + pause_reason + returns allowed:false. Subsequent calls all
--      short-circuit until admin clears via A4 unfreeze (deferred to S89).
--   3. override_cap_usd lets admins raise the cap for trusted users without
--      changing the global default; A4 admin UI surface (deferred).
--
-- Cleanup: pg_cron sweep deferred; the table accumulates ~1 row/user/day so
-- a 1-year retention sweep at OPS Sprint scope is sufficient.

CREATE TABLE IF NOT EXISTS haiku_spend_tracking (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_iso DATE NOT NULL,
  total_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  paused_at TIMESTAMPTZ NULL,
  pause_reason TEXT NULL,
  override_cap_usd NUMERIC(10, 2) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day_iso)
);

CREATE INDEX IF NOT EXISTS idx_haiku_spend_tracking_paused
  ON haiku_spend_tracking (paused_at)
  WHERE paused_at IS NOT NULL;

COMMENT ON TABLE haiku_spend_tracking IS
  'S74.6 D-cost §F.1 (Session 88). Per-user-day Haiku spend ledger. Enforces $10/user/day spend cap via reserve_haiku_spend RPC. paused_at signals cap-exceeded; admin A4 UI clears it. override_cap_usd lets admins raise the cap for individual users without changing the global default. Spend is recorded post-call (actual cost from Anthropic response) — pre-call check uses the rolling total. PRIMARY KEY (user_id, day_iso) gives natural per-day reset at UTC midnight.';

CREATE OR REPLACE FUNCTION reserve_haiku_spend(
  p_user_id UUID,
  p_call_cost_usd NUMERIC,
  p_cap_usd NUMERIC DEFAULT 10.0
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_today DATE := CURRENT_DATE;
  v_row haiku_spend_tracking%ROWTYPE;
  v_effective_cap NUMERIC;
  v_new_total NUMERIC;
BEGIN
  -- UPSERT empty row; concurrent inserts collapse on the composite PK.
  INSERT INTO haiku_spend_tracking (user_id, day_iso, total_cost_usd, updated_at)
  VALUES (p_user_id, v_today, 0, now())
  ON CONFLICT (user_id, day_iso) DO NOTHING;

  SELECT * INTO v_row FROM haiku_spend_tracking
  WHERE user_id = p_user_id AND day_iso = v_today
  FOR UPDATE;

  IF v_row.paused_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'already_paused',
      'paused_at', v_row.paused_at,
      'pause_reason', v_row.pause_reason
    );
  END IF;

  v_effective_cap := COALESCE(v_row.override_cap_usd, p_cap_usd);
  v_new_total := COALESCE(v_row.total_cost_usd, 0) + COALESCE(p_call_cost_usd, 0);

  IF v_new_total > v_effective_cap THEN
    UPDATE haiku_spend_tracking
    SET paused_at = now(),
        pause_reason = 'daily_spend_cap_exceeded',
        updated_at = now()
    WHERE user_id = p_user_id AND day_iso = v_today;

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'spend_cap_exceeded',
      'cap_usd', v_effective_cap,
      'attempted_total', v_new_total
    );
  END IF;

  UPDATE haiku_spend_tracking
  SET total_cost_usd = v_new_total, updated_at = now()
  WHERE user_id = p_user_id AND day_iso = v_today;

  RETURN jsonb_build_object(
    'allowed', true,
    'new_total_usd', v_new_total,
    'cap_usd', v_effective_cap
  );
END;
$$;

COMMENT ON FUNCTION reserve_haiku_spend(UUID, NUMERIC, NUMERIC) IS
  'S74.6 §F.1. Atomic spend-and-check on haiku_spend_tracking. Returns {allowed: true, new_total_usd, cap_usd} or {allowed: false, reason, ...}. Cap is per-user override_cap_usd if set, else p_cap_usd parameter (default $10). When new_total > cap, the row is paused (paused_at + pause_reason) and the function returns allowed:false; admin A4 UI clears paused_at to resume. FOR UPDATE serializes concurrent Haiku calls from the same user.';

GRANT EXECUTE ON FUNCTION reserve_haiku_spend(UUID, NUMERIC, NUMERIC) TO service_role;
