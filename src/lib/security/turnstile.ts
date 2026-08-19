/**
 * Cloudflare Turnstile server-side token verification.
 *
 * Used to gate user-initiated POST routes (signup, signin, password reset,
 * document upload) against bot abuse on the public-open MVP signup surface
 * (post-S67 waitlist removal).
 *
 * Verification calls Cloudflare's siteverify API with the token captured
 * client-side from the Turnstile widget. Tokens are single-use, valid for
 * ~5 minutes, and bound to the issuing site key.
 *
 * Environment variables:
 *   TURNSTILE_SECRET_KEY        — server-only secret. In non-prod environments
 *                                 (NODE_ENV !== "production" OR
 *                                 VERCEL_ENV !== "production") this defaults to
 *                                 Cloudflare's published always-pass test key
 *                                 so dev + preview deploys work without keys.
 *   NEXT_PUBLIC_TURNSTILE_SITE_KEY — client-readable site key. Same dev/preview
 *                                    fallback (always-pass test key) applied
 *                                    in TurnstileWidget.tsx.
 *
 * Feature flag: `turnstile_enforcement_v1` (mig 075). When OFF, callers should
 * skip verification entirely. When ON (post-S68 deploy), callers verify and
 * 403 on missing/invalid token.
 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare's published always-pass test secret. Safe to commit; documented at
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const ALWAYS_PASS_TEST_SECRET = "1x0000000000000000000000000000000AA";

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
  hostname?: string;
  challenge_ts?: string;
  action?: string;
}

function isProduction(): boolean {
  // Vercel sets VERCEL_ENV to "production" only on the live deploy; "preview"
  // and "development" both fall back to test keys. NODE_ENV is the local fallback.
  return process.env.VERCEL_ENV === "production"
    || (!process.env.VERCEL_ENV && process.env.NODE_ENV === "production");
}

function getSecret(): string {
  const real = process.env.TURNSTILE_SECRET_KEY;
  if (real) return real;
  if (isProduction()) {
    throw new Error(
      "TURNSTILE_SECRET_KEY is not set in production. Refusing to fall back to test secret.",
    );
  }
  return ALWAYS_PASS_TEST_SECRET;
}

export async function verifyTurnstileToken(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<TurnstileVerifyResult> {
  if (!token) {
    return { success: false, errorCodes: ["missing-input-response"] };
  }

  const body = new URLSearchParams();
  body.append("secret", getSecret());
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    console.error("[turnstile] siteverify fetch failed:", err);
    // Cloudflare unreachable — fail closed. Caller decides whether to surface
    // a retry message or hard-block.
    return { success: false, errorCodes: ["network-error"] };
  }

  if (!res.ok) {
    return { success: false, errorCodes: [`http-${res.status}`] };
  }

  let data: {
    success?: boolean;
    "error-codes"?: string[];
    hostname?: string;
    challenge_ts?: string;
    action?: string;
  };
  try {
    data = await res.json();
  } catch {
    return { success: false, errorCodes: ["invalid-json"] };
  }

  return {
    success: data.success === true,
    errorCodes: data["error-codes"],
    hostname: data.hostname,
    challenge_ts: data.challenge_ts,
    action: data.action,
  };
}

/**
 * Extract the client IP from a Next.js request, preferring the leftmost entry
 * of x-forwarded-for (the original client; subsequent entries are proxies).
 * Used as the optional remoteip parameter to siteverify.
 */
export function getRemoteIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip");
}

// ── S320: one human-check per session (config-gated acceptance) ─────────────
//
// Every account is BORN through a Turnstile-verified sync — signup, signin,
// and anon_check_start all pass userAction, and /api/auth/sync verifies the
// token before any row is created (S68/S315). So "this uid proved human at
// establishment" is already a recorded fact: users.created_at. When the
// config below is on, protected per-call routes (document upload) accept a
// session whose account is younger than the TTL in place of a fresh token —
// one challenge at the front door instead of one per step (the S320 mobile
// E2E hit three). Zero new storage; the master gate stays
// `turnstile_enforcement_v1` (config keys absent → OFF → byte-identical).
//
// Flip via the flag row's config JSONB (no deploy, ~60s cache):
//   {"session_established_skip": true, "session_established_ttl_minutes": 1440}

export interface TurnstileSessionConfig {
  /** Accept established sessions in place of a per-call token. Default OFF. */
  sessionEstablishedSkip: boolean;
  /** How long after account creation the establishment is honored. */
  sessionTtlMinutes: number;
}

export const DEFAULT_TURNSTILE_SESSION_CONFIG: TurnstileSessionConfig = {
  sessionEstablishedSkip: false,
  sessionTtlMinutes: 1440,
};

/** Parse the turnstile_enforcement_v1 config JSONB. Garbage-tolerant: any
 *  missing/mistyped key falls to the default (skip OFF), so a bad config edit
 *  can only ever restore today's per-call behavior, never widen acceptance. */
export function resolveTurnstileSessionConfig(raw: unknown): TurnstileSessionConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_TURNSTILE_SESSION_CONFIG;
  const cfg = raw as Record<string, unknown>;
  const skip = cfg.session_established_skip === true;
  const ttlRaw = cfg.session_established_ttl_minutes;
  const ttl =
    typeof ttlRaw === "number" && Number.isFinite(ttlRaw) && ttlRaw > 0
      ? ttlRaw
      : DEFAULT_TURNSTILE_SESSION_CONFIG.sessionTtlMinutes;
  return { sessionEstablishedSkip: skip, sessionTtlMinutes: ttl };
}

/** True iff the account was created (through a verified sync) within the TTL.
 *  Null/invalid created_at reads NOT established — fail toward challenging. */
export function isTurnstileSessionEstablished(
  createdAt: string | Date | null | undefined,
  config: TurnstileSessionConfig,
  now: Date = new Date(),
): boolean {
  if (!config.sessionEstablishedSkip || !createdAt) return false;
  const born = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const ageMs = now.getTime() - born.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  return ageMs < config.sessionTtlMinutes * 60_000;
}
