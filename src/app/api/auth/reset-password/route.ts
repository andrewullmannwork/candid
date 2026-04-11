import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/**
 * POST /api/auth/reset-password
 * Generates a Firebase password reset link and sends it via Resend
 * with branded Candid email template.
 */
export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    // Generate Firebase password reset link
    const resetLink = await getAdminAuth().generatePasswordResetLink(email, {
      url: `${process.env.NEXT_PUBLIC_APP_URL || "https://www.candidclaim.com"}/auth/signin`,
    });

    // Send branded email via Resend
    if (!resend) {
      return NextResponse.json({ error: "Email service not configured" }, { status: 503 });
    }
    await resend.emails.send({
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

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[reset-password] Error:", err);
    // Don't reveal whether email exists — always return success
    return NextResponse.json({ success: true });
  }
}
