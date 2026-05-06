import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { sendVerificationEmail } from "@/lib/email/onboarding-emails";
import { checkRateLimit } from "@/lib/security/rate-limit";

/**
 * POST /api/auth/resend-verification
 *
 * Re-sends the Firebase email-verification link to the authenticated user.
 * Used by the EmailVerifyBanner across the (app) shell when
 * `users.email_verified=false`. Auth via Authorization: Bearer <Firebase ID token>.
 *
 * Rate limit: 1 send per 60s per user, 5 sends per hour per user. Best-effort
 * (in-memory; doesn't survive cold starts). Primary defense is Resend's per-
 * recipient throttle + Firebase's action-link generation throttle.
 *
 * Skips silently (returns success) when the user's email is already verified —
 * the banner shouldn't be visible in that case but defensive coverage handles
 * a stale client.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }

    let decoded;
    try {
      decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[resend-verification] Token verify failed:", msg);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    if (decoded.email_verified === true) {
      return NextResponse.json({ success: true, alreadyVerified: true });
    }

    if (!decoded.email) {
      return NextResponse.json({ error: "No email on account" }, { status: 400 });
    }

    const limit = checkRateLimit(`resend-verify:${decoded.uid}`, {
      perMinute: 1,
      perHour: 5,
    });
    if (!limit.allowed) {
      const wait =
        limit.reason === "minute"
          ? `Please wait ${limit.retryAfterSeconds}s before requesting another email.`
          : "Too many resend attempts in the past hour. Try again later.";
      return NextResponse.json(
        { error: wait },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSeconds ?? 60) },
        },
      );
    }

    await sendVerificationEmail(decoded.email, decoded.name);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[resend-verification] Unhandled error:", message);
    return NextResponse.json(
      { error: "Failed to send verification email." },
      { status: 500 },
    );
  }
}
