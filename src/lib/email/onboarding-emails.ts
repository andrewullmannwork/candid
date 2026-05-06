/**
 * Transactional email helpers for first-time-user onboarding.
 * Both functions are fail-soft: a Resend failure logs but does not throw,
 * so signup never blocks on email delivery.
 */

import { Resend } from "resend";
import { getAdminAuth } from "@/lib/firebase/admin";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.candidclaim.com";
const FROM = "Candid <noreply@candidclaim.com>";

function getResend(): Resend | null {
  return process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
}

function firstNameOf(displayName: string | null | undefined): string {
  if (!displayName) return "there";
  const first = displayName.trim().split(/\s+/)[0];
  return first || "there";
}

/**
 * Send a Firebase-generated email-verification link via Resend.
 * Skipped silently if Resend is not configured.
 * Caller decides whether to fire (e.g., skip for Google OAuth users with
 * already-verified email).
 */
export async function sendVerificationEmail(
  email: string,
  displayName?: string | null
): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[onboarding-emails] RESEND_API_KEY missing — skipping verification email");
    return;
  }

  let verifyLink: string;
  try {
    // continueUrl points at our Candid-styled landing page so the user lands
    // on a Candid success card after Firebase processes the action — no flash
    // of the generic Firebase action page as the final destination. (Firebase
    // still hosts the action handler unless action URL is overridden in
    // Firebase Console; the redirect makes the Candid page the resting state.)
    verifyLink = await getAdminAuth().generateEmailVerificationLink(email, {
      url: `${APP_URL}/auth/verify-email`,
    });
  } catch (err) {
    console.error("[onboarding-emails] generateEmailVerificationLink failed:", err);
    return;
  }

  const greeting = firstNameOf(displayName);

  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: "Verify your Candid email address",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 700; color: #1d4ed8; margin: 0;">Candid</h1>
          </div>

          <h2 style="font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 12px;">Verify your email</h2>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 24px;">
            Hi ${greeting} — thanks for signing up for Candid. Tap the button below to confirm this is your email address.
          </p>

          <div style="text-align: center; margin: 32px 0;">
            <a href="${verifyLink}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
              Verify Email
            </a>
          </div>

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0 0 8px;">
            Or copy this link into your browser:
          </p>
          <p style="font-size: 12px; color: #6b7280; word-break: break-all; margin: 0 0 32px;">
            ${verifyLink}
          </p>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0;">
            If you didn&rsquo;t create a Candid account, you can safely ignore this email.
          </p>

          <p style="font-size: 12px; color: #d1d5db; margin: 24px 0 0; text-align: center;">
            From, The Candid Team<br />
            Candid is an Airgetlam Labs LLC company.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[onboarding-emails] Resend verification send failed:", err);
  }
}

/**
 * Send the welcome email on first-time signup.
 * Fail-soft: a Resend error is logged but does not block the signup flow.
 */
export async function sendWelcomeEmail(
  email: string,
  displayName?: string | null
): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[onboarding-emails] RESEND_API_KEY missing — skipping welcome email");
    return;
  }

  const greeting = firstNameOf(displayName);

  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: "Welcome to Candid",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="font-size: 28px; font-weight: 700; color: #1d4ed8; margin: 0;">Candid</h1>
          </div>

          <h2 style="font-size: 20px; font-weight: 600; color: #111827; margin: 0 0 12px;">Welcome, ${greeting}.</h2>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 16px;">
            Candid creates certainty about healthcare costs. Upload your insurance card and plan documents and we&rsquo;ll show you what you&rsquo;re actually covered for, audit your bills for errors, and help you dispute overcharges.
          </p>

          <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 24px;">
            To get the most out of Candid, your next step is to set up your profile and upload an insurance card or plan document.
          </p>

          <div style="text-align: center; margin: 32px 0;">
            <a href="${APP_URL}/profile?onboarding=true" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 10px;">
              Set up your profile
            </a>
          </div>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;" />

          <p style="font-size: 13px; color: #9ca3af; line-height: 1.5; margin: 0 0 8px;">
            Questions? Just reply to this email and we&rsquo;ll get back to you.
          </p>

          <p style="font-size: 12px; color: #d1d5db; margin: 24px 0 0; text-align: center;">
            From, The Candid Team<br />
            Candid is an Airgetlam Labs LLC company.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[onboarding-emails] Resend welcome send failed:", err);
  }
}
