/**
 * Outbound email for B2.3 Slack Tier 2 — when an admin replies in the Slack
 * thread of a support ticket, this sends the reply text to the original
 * submitter via Resend.
 *
 * FROM: Candid Support <support@candidclaim.com> (domain candidclaim.com
 *   already verified in Resend per existing onboarding-emails.ts pattern;
 *   support@ subaddress works without separate verification).
 * Reply-To: support@candidclaim.com — if user replies to the email, it
 *   routes through Cloudflare Email Routing to the team inbox (OPS.5 setup).
 *
 * Fail-soft: any Resend failure logs + returns false. Caller (Slack events
 * webhook) does NOT retry — Slack delivers events at-least-once and we'd
 * rather drop than double-email.
 */

import { Resend } from "resend";

const FROM = "Candid Support <support@candidclaim.com>";
const REPLY_TO = "support@candidclaim.com";

function getResend(): Resend | null {
  return process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
}

function shortIdFrom(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, 5).toUpperCase();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(s: string): string {
  return escapeHtml(s)
    .split("\n\n")
    .map((p) => `<p style="margin: 0 0 12px 0;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export interface SupportReplyParams {
  toEmail: string;
  ticketId: string;
  originalSubject: string;
  replyText: string;
  adminDisplayName?: string | null;
}

export async function sendSupportReply(p: SupportReplyParams): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    console.warn("[support-reply] RESEND_API_KEY missing — skipping reply email");
    return false;
  }

  const shortId = shortIdFrom(p.ticketId);
  const subject = p.originalSubject.toLowerCase().startsWith("re:")
    ? p.originalSubject
    : `Re: [#CN-${shortId}] ${p.originalSubject}`;

  const signoff = p.adminDisplayName ? `— ${p.adminDisplayName}, Candid Support` : "— Candid Support";
  const textBody = `${p.replyText}\n\n${signoff}\n\n---\nReplying to ticket #CN-${shortId}. Reply to this email to keep the conversation going.`;
  const htmlBody = `${textToHtml(p.replyText)}<p style="margin: 24px 0 8px 0; color: #6b7280; font-size: 14px;">${escapeHtml(signoff)}</p><hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0;"><p style="color: #9ca3af; font-size: 12px;">Replying to ticket <code>#CN-${shortId}</code>. Reply to this email to keep the conversation going.</p>`;

  try {
    const result = await resend.emails.send({
      from: FROM,
      to: p.toEmail,
      replyTo: REPLY_TO,
      subject,
      text: textBody,
      html: htmlBody,
    });
    if (result.error) {
      console.warn("[support-reply] Resend returned error:", result.error);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[support-reply] Resend send failed:", err);
    return false;
  }
}
