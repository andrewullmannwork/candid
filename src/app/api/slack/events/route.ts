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
 * Ack-fast, process-async: Slack requires a 200 within 3s or it counts the
 * delivery as failed and, after enough failures, disables the subscription
 * (the S275 "first reply works, then nothing" bug). So we do only the cheap
 * synchronous work (signature verify + parse + skip checks) before returning
 * 200, then run the slow work (ticket lookup + users.info + Resend + thread
 * confirmation) in after(). Idempotency is handled at the Resend send, keyed
 * on the Slack event_id, so a (now-rare) Slack retry never double-emails.
 * Pattern mirrors auth/reset-password + auth/admin-password.
 */

import { NextRequest, NextResponse, after } from "next/server";
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

/**
 * The slow path — runs in after(), off the Slack ack response. Ticket lookup
 * → users.info (display name) → Resend email → thread confirmation. Every
 * decision point logs (event_id + thread_ts) so Vercel logs are traceable;
 * before this the skip reasons were returned to Slack but never logged, which
 * is why the S275 debug was blind. Fail-soft throughout.
 */
async function processThreadReply(args: {
  threadTs: string;
  replyText: string;
  slackUser: string | null;
  eventId: string | null;
}): Promise<void> {
  const { threadTs, replyText, slackUser, eventId } = args;

  // Look up support ticket by slack_thread_ts. maybeSingle() → clean null on
  // the common case (a thread reply on any non-ticket message), no error.
  const supabase = createServerClient();
  const { data: ticket, error: lookupError } = await supabase
    .from("support_tickets")
    .select("id, email, subject, slack_thread_ts")
    .eq("slack_thread_ts", threadTs)
    .maybeSingle();

  if (lookupError) {
    console.warn(
      `[slack/events] ticket lookup error event_id=${eventId} thread_ts=${threadTs}: ${lookupError.message}`,
    );
    return;
  }
  if (!ticket) {
    console.log(
      `[slack/events] no matching ticket event_id=${eventId} thread_ts=${threadTs} — skipping`,
    );
    return;
  }
  console.log(`[slack/events] matched ticket id=${ticket.id} event_id=${eventId}`);

  // Look up Slack user's display name (for email signoff). Fail-soft.
  let adminDisplayName: string | null = null;
  if (slackUser && process.env.SLACK_BOT_TOKEN) {
    try {
      const userRes = await fetch(`https://slack.com/api/users.info?user=${slackUser}`, {
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

  // Send reply email via Resend. Idempotency-keyed on the Slack event_id so a
  // Slack retry (rare now that we ack fast) never double-emails.
  const sent = await sendSupportReply({
    toEmail: ticket.email,
    ticketId: ticket.id,
    originalSubject: ticket.subject,
    replyText,
    adminDisplayName,
    idempotencyKey: eventId ? `slack-reply:${eventId}` : null,
  });

  // Post confirmation back to thread so admin can see it worked.
  if (sent) {
    console.log(
      `[slack/events] emailed reply ticket=${ticket.id} to=${ticket.email} event_id=${eventId}`,
    );
    await postThreadConfirmation({
      threadTs,
      text: `✅ Emailed reply to ${ticket.email}`,
    });
  } else {
    console.warn(
      `[slack/events] email FAILED ticket=${ticket.id} to=${ticket.email} event_id=${eventId}`,
    );
    await postThreadConfirmation({
      threadTs,
      text: `⚠️ Failed to email reply to ${ticket.email} — check Resend logs`,
    });
  }
}

export async function POST(req: NextRequest) {
  // 1. Read raw body for signature verification (must NOT parse + re-stringify
  //    or the byte sequence differs and the HMAC fails).
  const rawBody = await req.text();
  const retryNum = req.headers.get("x-slack-retry-num");
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
  const eventId = payload.event_id ?? null;

  // Cheap synchronous skip checks (no I/O) — ack 200 immediately.
  if (event.type !== "message") {
    return NextResponse.json({ ok: true });
  }
  // Loop prevention: skip our own bot messages (incl. our ✅ confirmations).
  if (event.bot_id) {
    return NextResponse.json({ ok: true });
  }
  // Skip system events (message_changed, message_deleted, file_share, etc.).
  if (event.subtype) {
    return NextResponse.json({ ok: true });
  }
  // Only thread replies — skip parent / top-level messages.
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return NextResponse.json({ ok: true });
  }
  const replyText = event.text?.trim();
  if (!replyText) {
    return NextResponse.json({ ok: true });
  }

  // Ack Slack in <1s, then run the slow work AFTER the response via after().
  // Awaiting it inline blew past Slack's 3s ack limit on cold starts → Slack
  // disabled the subscription → intermittent delivery (S275).
  const threadTs = event.thread_ts;
  const slackUser = event.user ?? null;
  console.log(
    `[slack/events] arrived event_id=${eventId} thread_ts=${threadTs} retry=${retryNum ?? "0"}`,
  );

  after(async () => {
    try {
      await processThreadReply({ threadTs, replyText, slackUser, eventId });
    } catch (err) {
      console.error(`[slack/events] async processing failed event_id=${eventId}`, err);
    }
  });

  return NextResponse.json({ ok: true });
}
