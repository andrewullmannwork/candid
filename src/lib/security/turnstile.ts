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
