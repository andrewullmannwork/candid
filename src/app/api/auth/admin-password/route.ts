import { NextRequest, NextResponse, after } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { verifyTurnstileToken, getRemoteIp } from "@/lib/security/turnstile";
import {
  consumeRateLimit,
  registerLoginFailure,
  clearRateLimit,
  ipBucketKey,
} from "@/lib/security/durable-rate-limit";
import { loadAdminLoginPolicy, ADMIN_LOGIN_BUCKET_SCOPE } from "@/lib/security/admin-login-hardening";
import { notifyAdminLockout } from "@/lib/security/admin-login-slack";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOKIE_SECRET = process.env.ADMIN_PASSWORD || "candid-admin-fallback";

function makeToken(): string {
  return createHmac("sha256", COOKIE_SECRET).update("admin-authenticated").digest("hex");
}

export function verifyAdminPasswordCookie(cookieValue: string | undefined): boolean {
  if (!cookieValue || !ADMIN_PASSWORD) return false;
  try {
    const expected = makeToken();
    const a = Buffer.from(cookieValue, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function tooManyRequests(retryAfterSeconds: number, message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : undefined,
    },
  );
}

/**
 * POST: validate the admin password and set the auth cookie.
 *
 * B9-2 hardening (mig 197): durable per-IP rate-limit + progressive lockout + Turnstile,
 * layered on the existing constant-time compare. The limiter fails OPEN on any DB error
 * so a Supabase hiccup can never lock a legitimate admin out. Order matters:
 *   1) consume (rate-limit + active-lockout) BEFORE body parse — malformed floods count too
 *   2) Turnstile — a failed challenge is NOT a credential failure (no lockout increment)
 *   3) constant-time compare
 *   4) on failure register + (once) alert; on success clear the bucket
 */
export async function POST(req: NextRequest) {
  if (!ADMIN_PASSWORD) {
    // No password configured — nothing to brute-force; the gate is a no-op.
    return NextResponse.json({ success: true });
  }

  const policy = await loadAdminLoginPolicy();
  const ip = getRemoteIp(req) ?? "unknown";
  const bucket = ipBucketKey(ADMIN_LOGIN_BUCKET_SCOPE, ip);

  // (1) Durable rate-limit + active-lockout gate — before parsing the body.
  const gate = await consumeRateLimit(bucket, {
    windowSeconds: policy.windowSeconds,
    maxAttempts: policy.maxAttempts,
  });
  if (!gate.allowed) {
    const locked = !!gate.lockedUntil && gate.lockedUntil > new Date();
    return tooManyRequests(
      gate.retryAfterSeconds,
      locked
        ? "Too many failed attempts. This address is temporarily locked. Try again later."
        : "Too many requests. Please try again shortly.",
    );
  }

  // (2) Parse body — need the password + the Turnstile token.
  let password: string | undefined;
  let turnstileToken: string | undefined;
  try {
    const body = (await req.json()) as { password?: string; turnstileToken?: string };
    password = body.password;
    turnstileToken = body.turnstileToken;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  // (3) Turnstile — required when the global flag is ON and policy.turnstileRequired.
  // A failed challenge rejects WITHOUT counting as a credential failure.
  const turnstileEnforced = await isFeatureEnabled("turnstile_enforcement_v1");
  if (turnstileEnforced && policy.turnstileRequired) {
    const verify = await verifyTurnstileToken(turnstileToken, ip);
    if (!verify.success) {
      console.warn(
        "[admin-password] Turnstile verification failed, errors=" +
          JSON.stringify(verify.errorCodes ?? []),
      );
      return NextResponse.json(
        { error: "Bot defense check failed. Please reload and try again." },
        { status: 403 },
      );
    }
  }

  // (4) Constant-time comparison.
  const a = Buffer.from(password, "utf8");
  const b = Buffer.from(ADMIN_PASSWORD, "utf8");
  const match = a.length === b.length && timingSafeEqual(a, b);

  if (!match) {
    // (5) Record the failure. If it JUST crossed the threshold, alert once (via after(),
    // off the response path). Subsequent attempts are blocked at (1) and never reach here.
    const lockedUntil = await registerLoginFailure(bucket, {
      lockoutThreshold: policy.lockoutThreshold,
      lockoutSeconds: policy.lockoutSeconds,
    });
    if (lockedUntil) {
      const occurredAt = new Date();
      after(() =>
        notifyAdminLockout({
          route: "/api/auth/admin-password",
          environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
          clientIp: ip,
          lockoutThreshold: policy.lockoutThreshold,
          lockedUntil,
          lockoutSeconds: policy.lockoutSeconds,
          occurredAt,
        }),
      );
    }
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // (6) Success — reset the bucket, then set the cookie (unchanged cookie model).
  await clearRateLimit(bucket);

  const token = makeToken();
  const res = NextResponse.json({ success: true });
  res.cookies.set("admin_pw", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 24, // 24 hours
    path: "/",
  });

  return res;
}

/** GET: check if the admin password cookie is valid (unchanged — the cookie is an HMAC token, not a guessing vector). */
export async function GET(req: NextRequest) {
  if (!ADMIN_PASSWORD) {
    // No password configured — always valid
    return NextResponse.json({ authenticated: true });
  }

  const cookie = req.cookies.get("admin_pw")?.value;
  const valid = verifyAdminPasswordCookie(cookie);
  return NextResponse.json({ authenticated: valid });
}
