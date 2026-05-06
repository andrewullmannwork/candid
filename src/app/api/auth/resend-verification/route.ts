import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { sendVerificationEmail } from "@/lib/email/onboarding-emails";

/**
 * POST /api/auth/resend-verification
 *
 * Re-sends the Firebase email-verification link to the authenticated user.
 * Used by the EmailVerifyBanner across the (app) shell when
 * `users.email_verified=false`. Auth via Authorization: Bearer <Firebase ID token>.
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
