import { createServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Durable, distributed login rate-limit + progressive lockout, backed by the
 * Postgres `auth_rate_limits` table + RPCs (mig 197). Replaces the in-memory,
 * per-lambda-instance limiter (rate-limit.ts), which cannot bound an attacker who
 * spreads attempts across serverless instances / cold starts.
 *
 * All three wrappers FAIL SAFE:
 *  - consumeRateLimit() fails OPEN (allowed=true) on ANY error — a Supabase hiccup
 *    must never lock out a legitimate login; the credential compare (and, for the
 *    admin route, Turnstile) still gate. The open-fail is logged loudly.
 *  - registerLoginFailure() / clearRateLimit() are best-effort and never throw.
 *
 * Only service_role (BYPASSRLS) may call the RPCs — createServerClient() is the
 * service-role client. See mig 197 for the SQL + REVOKE/GRANT and the reset-on-
 * expired-lock semantics.
 */

export interface RateLimitWindow {
  /** Fixed window length in seconds. */
  windowSeconds: number;
  /** Max attempts permitted within a window before the request is denied. */
  maxAttempts: number;
}

export interface LockoutPolicy {
  /** Consecutive failures that trigger a lockout. */
  lockoutThreshold: number;
  /** Lockout duration in seconds. */
  lockoutSeconds: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Seconds to wait before retrying (0 when allowed). */
  retryAfterSeconds: number;
  /** Set when the bucket is in an active lockout; null otherwise. */
  lockedUntil: Date | null;
  /**
   * When denied by a WINDOW cap (not a lockout), the window length (seconds) that
   * limited — lets a multi-tier caller tell the minute tier from the hour tier.
   * Undefined when allowed or when denied by a lockout.
   */
  limitedWindowSeconds?: number;
}

const FAIL_OPEN: ConsumeResult = { allowed: true, retryAfterSeconds: 0, lockedUntil: null };

/** Build a consistent per-IP bucket key, e.g. ipBucketKey("admin-pw", ip). */
export function ipBucketKey(scope: string, ip: string | null | undefined): string {
  return `${scope}:ip:${ip ?? "unknown"}`;
}

/**
 * PRE-attempt gate. Atomically rolls the fixed window, honors an active lockout,
 * and counts this attempt. Fails OPEN on any error (see module doc).
 */
export async function consumeRateLimit(
  bucketKey: string,
  window: RateLimitWindow,
  client?: SupabaseClient,
): Promise<ConsumeResult> {
  try {
    const supabase = client ?? createServerClient();
    const { data, error } = await supabase.rpc("consume_login_rate_limit", {
      p_bucket_key: bucketKey,
      p_window_seconds: window.windowSeconds,
      p_max_attempts: window.maxAttempts,
    });
    if (error) throw error;
    // The RPC RETURNS TABLE(...), so PostgREST returns an array of rows.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { allowed?: boolean; retry_after_seconds?: number; locked_until?: string | null }
      | undefined;
    if (!row) return FAIL_OPEN;
    const allowed = row.allowed === true;
    const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
    return {
      allowed,
      retryAfterSeconds:
        typeof row.retry_after_seconds === "number" ? Math.max(0, row.retry_after_seconds) : 0,
      lockedUntil,
      // A window-cap denial (not a lockout) → tag the limiting window for tiered callers.
      limitedWindowSeconds: !allowed && !lockedUntil ? window.windowSeconds : undefined,
    };
  } catch (err) {
    console.error(
      "[durable-rate-limit] consume failed OPEN for",
      bucketKey,
      "-",
      err instanceof Error ? err.message : err,
    );
    return FAIL_OPEN;
  }
}

/**
 * Multi-tier rate-limit: run `baseKey` through each window tier (each tier gets its
 * OWN bucket, keyed by baseKey + window length), returning the FIRST limiting tier's
 * result (or allowed if all pass). Order tiers shortest-window-first so the tightest
 * burst limit reports first. Each tier fails OPEN independently.
 *
 * NOTE: a blocked request may have counted an attempt in an earlier tier — acceptable
 * (marginally stricter, never looser; short windows reset quickly). Use for the
 * non-lockout abuse-throttle routes (reset-password, resend-verification).
 */
export async function consumeTiers(
  baseKey: string,
  tiers: RateLimitWindow[],
  client?: SupabaseClient,
): Promise<ConsumeResult> {
  for (const tier of tiers) {
    const res = await consumeRateLimit(`${baseKey}:${tier.windowSeconds}`, tier, client);
    if (!res.allowed) return res;
  }
  return { allowed: true, retryAfterSeconds: 0, lockedUntil: null };
}

/**
 * POST-attempt, on a FAILED credential check. Increments the consecutive-failure
 * counter and locks once the threshold is crossed. Returns the new lock (or null).
 * Best-effort — never throws.
 */
export async function registerLoginFailure(
  bucketKey: string,
  policy: LockoutPolicy,
  client?: SupabaseClient,
): Promise<Date | null> {
  try {
    const supabase = client ?? createServerClient();
    const { data, error } = await supabase.rpc("register_login_failure", {
      p_bucket_key: bucketKey,
      p_lockout_threshold: policy.lockoutThreshold,
      p_lockout_seconds: policy.lockoutSeconds,
    });
    if (error) throw error;
    return data ? new Date(data as string) : null;
  } catch (err) {
    console.error(
      "[durable-rate-limit] registerLoginFailure failed for",
      bucketKey,
      "-",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** POST-attempt, on SUCCESS. Resets the bucket entirely. Best-effort — never throws. */
export async function clearRateLimit(bucketKey: string, client?: SupabaseClient): Promise<void> {
  try {
    const supabase = client ?? createServerClient();
    const { error } = await supabase.rpc("clear_login_rate_limit", {
      p_bucket_key: bucketKey,
    });
    if (error) throw error;
  } catch (err) {
    console.error(
      "[durable-rate-limit] clearRateLimit failed for",
      bucketKey,
      "-",
      err instanceof Error ? err.message : err,
    );
  }
}
