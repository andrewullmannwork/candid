/**
 * POST /api/slack/events
 *
 * Slack Events API webhook for B2.3 Slack Tier 2 — bidirectional thread
 * replies. When an admin (or any human in #support) replies in the thread
 * of a support-ticket message, we look up the ticket by slack_thread_ts and
 * email the reply to the original submitter via Resend.
 *
 * Slack contract:
 *   - Signature verification per https://api.slack.com/authentication/verifying-requests-from-slack
 *   - url_verification handshake on app install — respond with {challenge}
 *   - Subscribe to bot event: `message.channels` (public #support) AND/OR
 *     `message.groups` (private #support)
 *   - Bot User OAuth Token (xoxb-) must have channels:history OR groups:history scope
 *   - Bot must be invited to #support
 *
 * Loop prevention:
 *   - Skip events where event.bot_id is set (our own confirmation messages)
 *   - Skip events with subtype set (message_changed, message_deleted, file_share, etc.)
 *   - Skip events where thread_ts === ts (parent message, not a reply)
 *
 * Always respond 200 within 3s per Slack req — Slack retries on non-200 or
 * timeout, which would double-email.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { verifySlackSignature } from "@/lib/slack/verify-signature";
import { sendSupportReply } from "@/lib/email/support-reply";
import { postThreadConfirmation } from "@/lib/slack/support-notifications";

interface SlackUrlVerification {
  type: "url_verification";
  challenge: string;
  token?: string;
}

interface SlackMessageEvent {
  type: "message";
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackEventCallback {
  type: "event_callback";
  event: SlackMessageEvent;
  event_id?: string;
  event_time?: number;
}

type SlackPayload = SlackUrlVerification | SlackEventCallback;

export async function POST(req: NextRequest) {
  // 1. Read raw body for signature verification (must NOT parse + re-stringify
  //    or the byte sequence differs and the HMAC fails).
  const rawBody = await req.text();
  const verification = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  });

  if (!verification.valid) {
    console.warn(`[slack/events] Signature verification failed: ${verification.reason}`);
    return new NextResponse("Invalid signature", { status: 401 });
  }

  // 2. Parse payload
  let payload: SlackPayload;
  try {
    payload = JSON.parse(rawBody) as SlackPayload;
  } catch {
    return new NextResponse("Bad JSON", { status: 400 });
  }

  // 3. URL verification handshake (one-time on app install)
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // 4. Event callback — only process message events with thread_ts (replies)
  if (payload.type !== "event_callback") {
    return NextResponse.json({ ok: true });
  }

  const event = payload.event;
  if (event.type !== "message") {
    return NextResponse.json({ ok: true });
  }

  // Loop prevention: skip our own bot messages + system events
  if (event.bot_id) {
    return NextResponse.json({ ok: true, skipped: "bot_message" });
  }
  if (event.subtype) {
    return NextResponse.json({ ok: true, skipped: `subtype:${event.subtype}` });
  }

  // Only thread replies — skip parent messages (where thread_ts is unset or
  // equals ts itself)
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return NextResponse.json({ ok: true, skipped: "parent_or_top_level" });
  }

  const replyText = event.text?.trim();
  if (!replyText) {
    return NextResponse.json({ ok: true, skipped: "empty_text" });
  }

  // 5. Look up support ticket by slack_thread_ts
  const supabase = createServerClient();
  const { data: ticket, error: lookupError } = await supabase
    .from("support_tickets")
    .select("id, email, subject, slack_thread_ts")
    .eq("slack_thread_ts", event.thread_ts)
    .single();

  if (lookupError || !ticket) {
    // Thread reply on a non-support-ticket message — silently ignore.
    return NextResponse.json({ ok: true, skipped: "no_matching_ticket" });
  }

  // 6. Look up Slack user's display name (for email signoff). Fail-soft.
  let adminDisplayName: string | null = null;
  if (event.user && process.env.SLACK_BOT_TOKEN) {
    try {
      const userRes = await fetch(`https://slack.com/api/users.info?user=${event.user}`, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const userData = (await userRes.json()) as { ok: boolean; user?: { real_name?: string; profile?: { display_name?: string } } };
      if (userData.ok) {
        adminDisplayName = userData.user?.profile?.display_name || userData.user?.real_name || null;
      }
    } catch {
      // Ignore — signoff just won't include name
    }
  }

  // 7. Send reply email via Resend
  const sent = await sendSupportReply({
    toEmail: ticket.email,
    ticketId: ticket.id,
    originalSubject: ticket.subject,
    replyText,
    adminDisplayName,
  });

  // 8. Post confirmation back to thread so admin can see it worked
  if (sent) {
    await postThreadConfirmation({
      threadTs: event.thread_ts,
      text: `✅ Emailed reply to ${ticket.email}`,
    });
  } else {
    await postThreadConfirmation({
      threadTs: event.thread_ts,
      text: `⚠️ Failed to email reply to ${ticket.email} — check Resend logs`,
    });
  }

  return NextResponse.json({ ok: true });
}
