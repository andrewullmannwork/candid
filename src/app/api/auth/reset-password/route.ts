import { NextRequest, NextResponse, after } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { Resend } from "resend";
import { isFeatureEnabled } from "@/lib/config/product-flags";
import { verifyTurnstileToken, getRemoteIp } from "@/lib/security/turnstile";
import { checkRateLimit } from "@/lib/security/rate-limit";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/**
 * POST /api/auth/reset-password
 * Generates a Firebase password reset link and sends it via Resend
 * with branded Candid email template.
 *
 * Anti-enumeration posture (B9-F10):
 *  - Turnstile gate (S68) when `turnstile_enforcement_v1` is ON — the primary
 *    bot defense; each request needs a single-use Cloudflare token.
 *  - IP-keyed rate limit — bounds casual probing volume (in-memory per-instance).
 *  - The Resend send is decoupled via `after()` so existing vs non-existent
 *    accounts return after the same work (no timing oracle), and the response is
 *    a uniform `{ success: true }` regardless of account existence (no content
 *    oracle). Deferred-send failures are logged server-side, never surfaced.
 */
export async function POST(req: NextRequest) {
  try {
    const { email, turnstileToken } = (await req.json()) as {
      email?: string;
      turnstileToken?: string;
    };

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    // B9-F10 — IP-keyed rate limit (defense-in-depth vs enumeration; turnstile is
    // the primary bot gate). Keyed on the real client IP (leftmost x-forwarded-for
    // hop via getRemoteIp). In-memory per-instance; bounds casual probing, not
    // distributed attacks. Placed before turnstile so it throttles the cheap path
    // before the Cloudflare round-trip.
    const ip = getRemoteIp(req) ?? "unknown";
    const rl = checkRateLimit(`reset-pw:${ip}`, { perMinute: 3, perHour: 10 });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again shortly." },
        {
          status: 429,
          headers: rl.retryAfterSeconds
            ? { "Retry-After": String(rl.retryAfterSeconds) }
            : undefined,
        },
      );
    }

    // Turnstile gate (S68 mig 075).
    const turnstileEnforced = await isFeatureEnabled("turnstile_enforcement_v1");
    if (turnstileEnforced) {
      const verify = await verifyTurnstileToken(turnstileToken, getRemoteIp(req));
      if (!verify.success) {
        console.warn(
          "[reset-password] Turnstile verification failed, errors=" +
            JSON.stringify(verify.errorCodes ?? []),
        );
        return NextResponse.json(
          { error: "Bot defense check failed. Please reload and try again." },
          { status: 403 },
        );
      }
    }

    // Email-existence-independent (env constant) — symmetric across all callers.
    if (!resend) {
      return NextResponse.json({ error: "Email service not configured" }, { status: 503 });
    }
    const mailer = resend;

    // Generate Firebase password reset link. Throws auth/user-not-found for a
    // non-existent email — caught below and mapped to the SAME uniform success
    // response (no content oracle). Both branches reach this after one Firebase
    // round-trip; the only existence-dependent extra work (the Resend send) is
    // deferred via after(), so response timing is symmetric (B9-F10).
    const resetLink = await getAdminAuth().generatePasswordResetLink(email, {
      url: `${process.env.NEXT_PUBLIC_APP_URL || "https://www.candidclaim.com"}/auth/signin`,
    });

    // Decouple the branded send from the response — runs after the response is
    // sent so it adds no time to the request. Failures are logged, never surfaced.
    after(async () => {
      try {
        await mailer.emails.send({
          from: "Candid <noreply@candidclaim.com>",
          to: email,
          subject: "Reset your Candid password",
          html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 700; color: #1d4ed8; margin: 0;">Candid</h1>
          </div>

          <h2 style="font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 12px;">Reset your password</h2>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 24px;">
            We received a request to reset the password for your Candid account (<strong>${email}</strong>).
            Click the button below to choose a new password.
          </p>

          <div style="text-align: center; margin: 32px 0;">
            <a href="${resetLink}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
              Reset Password
            </a>
          </div>

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0 0 8px;">
            Or copy this link into your browser:
          </p>
          <p style="font-size: 12px; color: #6b7280; word-break: break-all; margin: 0 0 32px;">
            ${resetLink}
          </p>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0;">
            If you didn&rsquo;t request this, you can safely ignore this email. Your password won&rsquo;t change.
          </p>

          <p style="font-size: 12px; color: #d1d5db; margin: 24px 0 0; text-align: center;">
            From, The Candid Team<br />
            Candid is an Airgetlam Labs LLC company.
          </p>
        </div>
      `,
        });
      } catch (sendErr) {
        console.error(
          "[reset-password] deferred send failed:",
          sendErr instanceof Error ? sendErr.message : sendErr,
        );
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const fbErr = err as { code?: string };
    // Firebase "user not found" / "invalid email" — return uniform success to
    // prevent account enumeration.
    if (fbErr.code === "auth/user-not-found" || fbErr.code === "auth/invalid-email") {
      return NextResponse.json({ success: true });
    }
    // Unexpected error (e.g. Firebase outage) — existence-independent, so a 500
    // here is not an enumeration signal.
    console.error("[reset-password] Error:", err);
    return NextResponse.json(
      { error: "Failed to send reset email. Please try again." },
      { status: 500 },
    );
  }
}
