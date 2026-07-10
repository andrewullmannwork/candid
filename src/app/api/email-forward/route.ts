/**
 * POST /api/email-forward
 *
 * Inbound email → Slack thread (Direction B of the support reply loop). When a
 * user replies to a support email (Reply-To: support@candidclaim.com), Resend
 * Inbound delivers an `email.received` webhook here. We verify the Svix
 * signature, fetch the full body from Resend, match the ticket by the #CN-XXXXX
 * ref in the subject (+ sender-email collision guard), strip the quoted reply
 * history, and post the user's reply into the ticket's Slack thread so the team
 * sees it inline.
 *
 * History: this endpoint previously forwarded inbound mail to a personal Gmail
 * and was DISABLED at S199 (E3 — CHD to an uncovered mailbox). It is now
 * rebuilt to post into Slack (a disclosed processor) instead.
 *
 * Reliability: inbound webhooks have no 3s ack limit (unlike Slack's outbound
 * events), so we process INLINE and return 500 on TRANSIENT failures (Resend
 * fetch / Slack post errors) to let Resend's webhook retry redeliver. Permanent
 * drops (loop/bounce sender, no #CN ref, no ticket match, empty reply) return
 * 200 so Resend does not retry them.
 *
 * Privacy: never log the full subject/body (CHD). Log only the opaque Resend
 * email_id, the derived shortId, and a redacted sender.
 */

import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { createServerClient } from "@/lib/supabase/server";
import { postUserEmailReply } from "@/lib/slack/support-notifications";
import {
  extractEmail,
  redactEmail,
  isLoopOrBounce,
  extractShortId,
  stripQuotedReply,
  shortIdRange,
} from "@/lib/email/inbound-reply-parse";

const RESEND_API_BASE = "https://api.resend.com";
const IS_VERCEL_DEPLOY = !!process.env.VERCEL_ENV;

/**
 * Fetch the inbound body, match the ticket, and post to Slack. Returns
 * { retry } — true means a TRANSIENT failure (caller returns 500 so Resend
 * redelivers); false means done (success or a permanent drop → 200).
 */
async function processInboundReply(args: {
  emailId: string;
  senderEmail: string;
  shortId: string;
}): Promise<{ retry: boolean }> {
  const { emailId, senderEmail, shortId } = args;
  const who = redactEmail(senderEmail);

  // Resend's webhook carries only metadata — fetch the full body via the API.
  if (!process.env.RESEND_API_KEY) {
    console.error("[email-forward] RESEND_API_KEY missing — cannot fetch inbound body");
    return { retry: true };
  }
  let text = "";
  try {
    const res = await fetch(`${RESEND_API_BASE}/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    });
    const data = (await res.json()) as { text?: string; html?: string };
    if (!res.ok) {
      console.error(`[email-forward] Resend fetch failed email_id=${emailId}: ${JSON.stringify(data).slice(0, 200)}`);
      return { retry: true };
    }
    text = data.text || "";
  } catch (err) {
    console.error(`[email-forward] Resend fetch error email_id=${emailId}:`, err);
    return { retry: true };
  }

  const replyText = stripQuotedReply(text);
  if (!replyText) {
    console.log(`[email-forward] empty reply after strip shortId=${shortId} sender=${who} — dropping`);
    return { retry: false };
  }

  // Match the ticket by shortId (UUID prefix range) + sender email (collision
  // guard — 5 hex ≈ 1M, so require both).
  const supabase = createServerClient();
  const { lo, hi } = shortIdRange(shortId);
  let query = supabase
    .from("support_tickets")
    .select("id, email, subject, slack_thread_ts")
    .gte("id", lo);
  if (hi) query = query.lt("id", hi);
  const { data: rows, error } = await query;
  if (error) {
    console.warn(`[email-forward] ticket lookup error shortId=${shortId}: ${error.message}`);
    return { retry: true };
  }
  const ticket = (rows ?? []).find(
    (t) =>
      t.id.replace(/-/g, "").slice(0, 5).toUpperCase() === shortId &&
      (t.email ?? "").toLowerCase() === senderEmail,
  );
  if (!ticket) {
    console.log(`[email-forward] no ticket match shortId=${shortId} sender=${who} — dropping`);
    return { retry: false };
  }
  if (!ticket.slack_thread_ts) {
    console.warn(`[email-forward] ticket ${ticket.id} has no slack_thread_ts — cannot post`);
    return { retry: false };
  }

  const posted = await postUserEmailReply({
    threadTs: ticket.slack_thread_ts,
    senderEmail,
    replyText,
  });
  if (!posted) {
    console.warn(`[email-forward] Slack post failed ticket=${ticket.id} — will retry`);
    return { retry: true };
  }
  console.log(`[email-forward] posted user reply → thread ${ticket.slack_thread_ts} (ticket ${ticket.id})`);
  return { retry: false };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // 1. Verify the Svix signature on Vercel deploys (local dev is never a real
  //    Resend webhook target). Fail-closed in prod.
  if (IS_VERCEL_DEPLOY) {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[email-forward] FATAL: RESEND_WEBHOOK_SECRET missing in Vercel deploy");
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
    }
    const svixId = req.headers.get("svix-id");
    const svixTimestamp = req.headers.get("svix-timestamp");
    const svixSignature = req.headers.get("svix-signature");
    if (!svixId || !svixTimestamp || !svixSignature) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      new Webhook(secret).verify(rawBody, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      });
    } catch (err) {
      console.warn("[email-forward] Signature verification failed:", err);
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[email-forward] Signature verification skipped — not a Vercel deploy");
  }

  // 2. Parse; only handle inbound receipts.
  let body: { type?: string; data?: { email_id?: string; from?: string; subject?: string } };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (body?.type !== "email.received") {
    return NextResponse.json({ received: true });
  }

  const emailId = body.data?.email_id;
  const from = typeof body.data?.from === "string" ? body.data.from : "";
  const subject = typeof body.data?.subject === "string" ? body.data.subject : "";
  const senderEmail = extractEmail(from);
  console.log(`[email-forward] received email_id=${emailId ?? "?"} sender=${redactEmail(senderEmail)}`);

  // 3. Cheap synchronous drops — before the Resend fetch. All return 200
  //    (permanent; do not retry).
  if (isLoopOrBounce(senderEmail, subject)) {
    console.log("[email-forward] loop/bounce sender — dropping");
    return NextResponse.json({ received: true });
  }
  const shortId = extractShortId(subject);
  if (!shortId) {
    console.log("[email-forward] no #CN ref in subject — dropping");
    return NextResponse.json({ received: true });
  }
  if (!emailId) {
    console.warn("[email-forward] missing email_id — cannot fetch body");
    return NextResponse.json({ received: true });
  }

  // 4. Fetch body + match ticket + post to Slack. Transient failures → 500 so
  //    Resend redelivers; permanent outcomes → 200.
  const { retry } = await processInboundReply({ emailId, senderEmail, shortId });
  return NextResponse.json({ received: !retry }, { status: retry ? 500 : 200 });
}
