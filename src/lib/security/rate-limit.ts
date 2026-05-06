/**
 * Simple in-memory rate limiter for serverless API routes.
 *
 * MVP-grade: state is per-function-instance and does NOT survive cold starts.
 * Worst case under heavy concurrency: a user gets through ~2× the configured
 * limit when Vercel spins up a fresh instance. Acceptable at MVP scale; the
 * primary defense is Resend's own per-recipient throttle + Firebase's
 * action-link generation throttle. This layer just returns friendly 429s
 * before burning vendor quota.
 *
 * Phase 2 follow-up: promote to durable storage (Vercel KV / Redis / Supabase
 * with row-level locking) when traffic grows.
 */

interface WindowEntry {
  count: number;
  resetAt: number;
}

interface Buckets {
  perMinute: WindowEntry;
  perHour: WindowEntry;
}

const RATE_LIMIT_STATE = new Map<string, Buckets>();

/**
 * Periodic GC so the Map doesn't grow unbounded for high-traffic keys that
 * later go cold. Runs at most once per minute on first call after a minute.
 */
let lastGcAt = 0;
function maybeGc(now: number) {
  if (now - lastGcAt < 60_000) return;
  lastGcAt = now;
  for (const [key, b] of RATE_LIMIT_STATE) {
    if (b.perHour.resetAt <= now) RATE_LIMIT_STATE.delete(key);
  }
}

interface CheckLimitOptions {
  perMinute: number;
  perHour: number;
}

interface CheckLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: "minute" | "hour";
}

/**
 * Returns whether the action is allowed for `key`. If allowed, increments
 * both windows. If not, returns retryAfterSeconds for the limiting window.
 */
export function checkRateLimit(
  key: string,
  opts: CheckLimitOptions,
): CheckLimitResult {
  const now = Date.now();
  maybeGc(now);

  let buckets = RATE_LIMIT_STATE.get(key);
  if (!buckets || buckets.perMinute.resetAt <= now) {
    buckets = buckets ?? { perMinute: { count: 0, resetAt: 0 }, perHour: { count: 0, resetAt: 0 } };
    if (buckets.perMinute.resetAt <= now) {
      buckets.perMinute = { count: 0, resetAt: now + 60_000 };
    }
    if (buckets.perHour.resetAt <= now) {
      buckets.perHour = { count: 0, resetAt: now + 3_600_000 };
    }
    RATE_LIMIT_STATE.set(key, buckets);
  }

  if (buckets.perMinute.count >= opts.perMinute) {
    return {
      allowed: false,
      reason: "minute",
      retryAfterSeconds: Math.max(1, Math.ceil((buckets.perMinute.resetAt - now) / 1000)),
    };
  }
  if (buckets.perHour.count >= opts.perHour) {
    return {
      allowed: false,
      reason: "hour",
      retryAfterSeconds: Math.max(1, Math.ceil((buckets.perHour.resetAt - now) / 1000)),
    };
  }

  buckets.perMinute.count += 1;
  buckets.perHour.count += 1;
  return { allowed: true };
}
