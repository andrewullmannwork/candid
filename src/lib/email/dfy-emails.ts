/**
 * dfy-emails — the DFY lane's two transactional emails (S330), on the SAME
 * Resend sender as every other Candid email. Fail-soft: a delivery failure
 * logs and never blocks the engagement.
 *
 *   sendDfyInvitationEmail   the operator opened an engagement — the member
 *                            signs the paper stack on their own page
 *   sendDfyMatterUpdateEmail an operator recorded a plan response / offer /
 *                            determination — the member reviews it on their
 *                            own surfaces (the operator never answers for them)
 */
import { Resend } from "resend";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.candidclaim.com";
const FROM = "Candid <noreply@candidclaim.com>";

function getResend(): Resend | null {
  return process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export async function sendDfyInvitationEmail(params: {
  to: string;
  firstName: string | null;
  engagementId: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[dfy-emails] RESEND_API_KEY missing — skipping invitation email");
    return;
  }
  const url = `${APP_URL}/dfy/${params.engagementId}`;
  const name = params.firstName ? esc(params.firstName) : "there";
  try {
    await resend.emails.send({
      from: FROM,
      to: params.to,
      subject: "We can take your appeal from here",
      html: `<p>Hi ${name},</p>
<p>You built an appeal in Candid. Want us to handle the rest? We'll prepare it, submit it as your authorized representative, and follow up until you have an answer.</p>
<p>Click here to sign up.</p>
<p><a href="${url}">Sign up</a></p>
<p>You can always file on your own at no cost using our free Candid tools.</p>
<p>— Candid</p>`,
      text: `Hi ${name},\n\nYou built an appeal in Candid. Want us to handle the rest? We'll prepare it, submit it as your authorized representative, and follow up until you have an answer.\n\nClick here to sign up:\n${url}\n\nYou can always file on your own at no cost using our free Candid tools.\n\n— Candid`,
    });
  } catch (err) {
    console.error("[dfy-emails] invitation send failed (fail-soft):", err);
  }
}

export async function sendDfyMatterUpdateEmail(params: {
  to: string;
  firstName: string | null;
  claimId: string;
  /** Plain words, no verdicts: "recorded a response from your plan" etc. */
  what: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.warn("[dfy-emails] RESEND_API_KEY missing — skipping matter-update email");
    return;
  }
  const url = `${APP_URL}/claim?claim=${params.claimId}`;
  const name = params.firstName ? esc(params.firstName) : "there";
  try {
    await resend.emails.send({
      from: FROM,
      to: params.to,
      subject: "An update on your appeal",
      html: `<p>Hi ${name},</p>
<p>We ${esc(params.what)}. It's on your claim timeline. Any decision is yours to make.</p>
<p><a href="${url}">Open your claim</a></p>
<p>— Candid</p>`,
      text: `Hi ${name},\n\nWe ${params.what}. It's on your claim timeline. Any decision is yours to make.\n\n${url}\n\n— Candid`,
    });
  } catch (err) {
    console.error("[dfy-emails] matter-update send failed (fail-soft):", err);
  }
}

/** The daily SLA nudge to a holder — facts and links, nothing else. */
export async function sendDfyOperatorSlaEmail(params: {
  to: string;
  items: Array<{ engagementId: string; reasons: string[] }>;
}): Promise<void> {
  const resend = getResend();
  if (!resend) return;
  const rows = params.items.map((i) => `• ${APP_URL}/admin/dfy/${i.engagementId} — ${i.reasons.join("; ")}`);
  try {
    await resend.emails.send({
      from: FROM,
      to: params.to,
      subject: `DFY: ${params.items.length} matter(s) need attention today`,
      text: `Matters you hold that breach the operator SLA:\n\n${rows.join("\n")}\n\n— Candid ops`,
      html: `<p>Matters you hold that breach the operator SLA:</p><ul>${params.items.map((i) => `<li><a href="${APP_URL}/admin/dfy/${i.engagementId}">${i.engagementId.slice(0, 8)}</a> — ${esc(i.reasons.join("; "))}</li>`).join("")}</ul><p>— Candid ops</p>`,
    });
  } catch (err) {
    console.error("[dfy-emails] SLA send failed (fail-soft):", err);
  }
}

/** Intake decline — the member's plain sentence, never the operator's audit reason. */
export async function sendDfyDeclineEmail(params: {
  to: string;
  firstName: string | null;
  claimId: string;
  /** The MEMBER_DECLINE_COPY sentence (or a generic one) — already plain words. */
  reason: string;
}): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    console.warn("[dfy-emails] RESEND_API_KEY missing — skipping decline email");
    return false;
  }
  const url = `${APP_URL}/claim?claim=${params.claimId}`;
  const name = params.firstName ? esc(params.firstName) : "there";
  try {
    await resend.emails.send({
      from: FROM,
      to: params.to,
      subject: "About your appeal request",
      html: `<p>Hi ${name},</p>
<p>We looked at your request for Candid to handle your appeal and can't take this one on. ${esc(params.reason)}</p>
<p>Your appeal and every free Candid tool stay yours, and you can always file on your own at no cost.</p>
<p><a href="${url}">Open your claim</a></p>
<p>— Candid</p>`,
      text: `Hi ${name},\n\nWe looked at your request for Candid to handle your appeal and can't take this one on. ${params.reason}\n\nYour appeal and every free Candid tool stay yours, and you can always file on your own at no cost.\n\n${url}\n\n— Candid`,
    });
    return true;
  } catch (err) {
    console.error("[dfy-emails] decline send failed (fail-soft):", err);
    return false;
  }
}
