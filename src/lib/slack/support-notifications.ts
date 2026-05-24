/**
 * Slack #support channel notifications for B2.3 support tickets.
 *
 * Uses chat.postMessage (not Incoming Webhook) because we need the returned
 * message `ts` to store as support_tickets.slack_thread_ts for inbound
 * thread-reply routing in /api/slack/events.
 *
 * Fail-soft: any Slack failure logs + returns null. The ticket itself is
 * already in the DB by the time we're called — never block ticket creation
 * on Slack delivery.
 *
 * Required env vars:
 *   - SLACK_BOT_TOKEN — xoxb-... (chat:write scope; bot invited to #support)
 *   - SLACK_SUPPORT_CHANNEL_ID — Slack channel ID (Cxxxxx) for #support
 */

const SLACK_API_BASE = "https://slack.com/api";
const BODY_PREVIEW_CHARS = 800;

const CATEGORY_EMOJI: Record<string, string> = {
  bill: "🧾",
  plan: "📋",
  benefits: "🛡️",
  billing: "💳",
  other: "❓",
};

function shortIdFrom(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, 5).toUpperCase();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function mailtoForReply(opts: {
  userEmail: string;
  ticketShortId: string;
  subject: string;
  body: string;
}): string {
  const to = encodeURIComponent(opts.userEmail);
  const subject = encodeURIComponent(`Re: [#CN-${opts.ticketShortId}] ${opts.subject}`);
  const quoted = opts.body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const body = encodeURIComponent(`\n\n\n— Candid Support\n\n---\n${quoted}\n`);
  return `mailto:${to}?subject=${subject}&body=${body}`;
}

export interface SupportTicketSlackPayload {
  ticketId: string;
  userEmail: string;
  category: string | null;
  subject: string;
  body: string;
  linkedDocumentName?: string | null;
  attachmentFilename?: string | null;
  attachmentSizeBytes?: number | null;
  appUrl?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Post a new support ticket to the #support Slack channel via
 * chat.postMessage. Returns the message `ts` on success (caller stores it
 * as support_tickets.slack_thread_ts) or null on any failure.
 */
export async function postSupportTicket(p: SupportTicketSlackPayload): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_SUPPORT_CHANNEL_ID;

  if (!token || !channel) {
    console.warn("[slack-support] SLACK_BOT_TOKEN or SLACK_SUPPORT_CHANNEL_ID not configured — skipping ticket notification");
    return null;
  }

  const shortId = shortIdFrom(p.ticketId);
  const categoryLabel = p.category ?? "uncategorized";
  const emoji = CATEGORY_EMOJI[p.category ?? ""] ?? "🎫";

  const bodyPreview = truncate(p.body, BODY_PREVIEW_CHARS);
  const contextLines: string[] = [];
  if (p.linkedDocumentName) contextLines.push(`🔗 Linked doc: *${p.linkedDocumentName}*`);
  if (p.attachmentFilename) {
    const size = p.attachmentSizeBytes ? ` (${formatSize(p.attachmentSizeBytes)})` : "";
    contextLines.push(`📎 Attachment: *${p.attachmentFilename}*${size}`);
  }

  const mailto = mailtoForReply({
    userEmail: p.userEmail,
    ticketShortId: shortId,
    subject: p.subject,
    body: p.body,
  });

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} New support ticket  ·  #CN-${shortId}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*From:*\n${p.userEmail}` },
        { type: "mrkdwn", text: `*Category:*\n${categoryLabel}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Subject:* ${p.subject}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: bodyPreview },
    },
  ];

  if (contextLines.length > 0) {
    blocks.push({
      type: "context",
      elements: contextLines.map((t) => ({ type: "mrkdwn", text: t })),
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "💬 *Reply in this thread* → automatically emails the user via Resend.",
      },
    ],
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Reply via email (fallback)" },
        url: mailto,
      },
    ],
  });

  try {
    const res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        text: `New support ticket #CN-${shortId} from ${p.userEmail}`, // fallback for notifications
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });

    const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) {
      console.warn(`[slack-support] chat.postMessage failed: ${data.error ?? "unknown"}`);
      return null;
    }
    return data.ts ?? null;
  } catch (err) {
    console.warn("[slack-support] chat.postMessage network error:", err);
    return null;
  }
}

/**
 * Post a confirmation reply back to the Slack thread after we've successfully
 * emailed the user. Fail-soft.
 */
export async function postThreadConfirmation(opts: {
  threadTs: string;
  text: string;
}): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_SUPPORT_CHANNEL_ID;
  if (!token || !channel) return;

  try {
    await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        thread_ts: opts.threadTs,
        text: opts.text,
      }),
    });
  } catch (err) {
    console.warn("[slack-support] thread confirmation failed:", err);
  }
}
