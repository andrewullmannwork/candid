import { createServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tunable policy for admin-login hardening, read from the `admin_login_hardening_v1`
 * feature-flag config (mig 197).
 *
 * FAIL-SAFE by design: on ANY error, or a missing/invalid config key, we fall back to
 * the SAFE hardcoded defaults below — so brute-force protection is ALWAYS active and
 * can never be silently disabled by a missing/OFF flag row. Values are clamped to sane
 * ranges so a fat-fingered config can neither lock everyone out nor open the gate.
 *
 * `enabled` is intentionally NOT read here (protection is not gate-able). The only
 * config escape hatch is `turnstile_required:false` (drops the Turnstile requirement
 * without a deploy). If the rate-limit/lockout itself ever locks the real admin out,
 * the manual escape is a service-role delete of that bucket, e.g.
 *   DELETE FROM auth_rate_limits WHERE bucket_key LIKE 'admin-pw:%';
 */

export interface AdminLoginPolicy {
  windowSeconds: number;
  maxAttempts: number;
  lockoutThreshold: number;
  lockoutSeconds: number;
  turnstileRequired: boolean;
}

export const ADMIN_LOGIN_DEFAULTS: AdminLoginPolicy = {
  windowSeconds: 900, // 15 min window
  maxAttempts: 10, // attempts per window (loose flood backstop)
  lockoutThreshold: 5, // consecutive failures → lock
  lockoutSeconds: 900, // 15 min lock (fixed, not escalating)
  turnstileRequired: true,
};

/** Bucket scope for the admin-login limiter — see ipBucketKey(scope, ip). */
export const ADMIN_LOGIN_BUCKET_SCOPE = "admin-pw";

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

export async function loadAdminLoginPolicy(client?: SupabaseClient): Promise<AdminLoginPolicy> {
  try {
    const supabase = client ?? createServerClient();
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "admin_login_hardening_v1")
      .single();
    const cfg = (data?.config ?? {}) as Record<string, unknown>;
    return {
      windowSeconds: clampInt(cfg.window_seconds, 30, 86_400, ADMIN_LOGIN_DEFAULTS.windowSeconds),
      maxAttempts: clampInt(cfg.max_attempts, 1, 10_000, ADMIN_LOGIN_DEFAULTS.maxAttempts),
      lockoutThreshold: clampInt(
        cfg.lockout_threshold,
        1,
        10_000,
        ADMIN_LOGIN_DEFAULTS.lockoutThreshold,
      ),
      lockoutSeconds: clampInt(cfg.lockout_seconds, 30, 86_400, ADMIN_LOGIN_DEFAULTS.lockoutSeconds),
      turnstileRequired:
        typeof cfg.turnstile_required === "boolean"
          ? cfg.turnstile_required
          : ADMIN_LOGIN_DEFAULTS.turnstileRequired,
    };
  } catch (err) {
    console.error(
      "[admin-login-hardening] policy load failed, using safe defaults:",
      err instanceof Error ? err.message : err,
    );
    return { ...ADMIN_LOGIN_DEFAULTS };
  }
}
