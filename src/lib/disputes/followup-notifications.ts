/**
 * Follow-up Notifications — email + Slack for dispute outcome prompts.
 *
 * At 30 days after filing, sends an email: "Your dispute was filed 30 days ago. What happened?"
 * If denied: "Submit to Candid Case — included with Candid Pro."
 *
 * Uses Slack webhook (current notification system) + optional email via Resend if configured.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://candidclaim.com";

// ── Slack helper ────────────────────────────────────────────────────────────

async function sendSlack(payload: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[followup-notifications] Slack failed:", err);
  }
}

// ── Email helper (Resend) ───────────────────────────────────────────────────

async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("[followup-notifications] RESEND_API_KEY not configured — email skipped");
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: "Candid <noreply@candidclaim.com>",
        to: [params.to],
        subject: params.subject,
        html: params.html,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("[followup-notifications] Email send failed:", err);
    return false;
  }
}

// ── Date helpers ────────────────────────────────────────────────────────────

/**
 * Email-safe date rendering. Date-only strings ("2026-08-12" — governing
 * deadlines) are pinned to UTC so they never render as the previous day; full
 * timestamps parse natively. Same rule the letters' formatDate follows.
 */
function formatEmailDate(iso: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Date-only comparison for the deadline tense guard. */
function isPastDate(iso: string): boolean {
  const today = new Date().toISOString().split("T")[0];
  return iso < today;
}

// ── Follow-up notifications ─────────────────────────────────────────────────

/**
 * Send a follow-up notification for ONE letter (agenda §0.9c — one topic per
 * email). Each email is fired by a single letter's clock, so its subject, body
 * and destination name the SAME letter and land on that letter's step. Other
 * waits on the same bill get one muted context line, never co-billing.
 *
 * Still deliberately generic on DETAIL — no dollar amounts, no insurer or
 * provider names in email; those live behind login (Andrew review 2026-07-17).
 * The letter's TYPE is not identifying, so it can be named.
 *
 * Dates, not day-counts: `daysAgo` was computed server-side from a DATE column
 * against the server's clock, which is the same UTC-calendar defect that made
 * the rail say "Jul 31" while the dispute page said "Jul 30" (S299). A date is
 * timezone-proof and reads better.
 */
export async function notifyDisputeFollowup(params: {
  userEmail: string;
  disputeId: string;
  disputeType: string;
  amountDisputed: number;
  filedDate: string;
  followupType: string;
  insurerName?: string;
  /** S300 — the letter this nudge is about + where it lives. */
  claimId?: string | null;
  letterLabel?: string | null;
  sentDate?: string | null;
  /** Graduated deadline nudges (`deadline_interim` / `deadline_final`) get variant B. */
  followupKind?: string | null;
  governingDeadlineDate?: string | null;
  /** Other letters waiting on the SAME bill — one muted line, no detail. */
  otherWaitingCount?: number;
}): Promise<void> {
  const { userEmail, disputeType, amountDisputed, filedDate, followupType } = params;
  const daysAgo = Math.floor((Date.now() - new Date(filedDate).getTime()) / (1000 * 60 * 60 * 24));
  // Per-letter landing: the claim rail, anchored on THIS letter's step. The
  // anchor is the dispute id, never a step number — emails outlive step
  // numbering (phase 3 renumbers the rail; inboxes don't re-render).
  const claimUrl = params.claimId
    ? `${APP_URL}/claim?claim=${params.claimId}${params.disputeId ? `&letter=${params.disputeId}` : ""}`
    : `${APP_URL}/claim`;
  const label = params.letterLabel || disputeType.replace(/_/g, " ");
  const sentOn = params.sentDate ? formatEmailDate(params.sentDate) : null;
  const deadlineOn = params.governingDeadlineDate
    ? formatEmailDate(params.governingDeadlineDate)
    : null;
  const isDeadline =
    typeof params.followupKind === "string" && params.followupKind.startsWith("deadline_");
  const isFinal = params.followupKind === "deadline_final" || followupType === "final";
  const others = params.otherWaitingCount ?? 0;
  const contextLine =
    others > 0
      ? others === 1
        ? "You have 1 other letter waiting on this bill &mdash; you'll find it on the same page."
        : `You have ${others} other letters waiting on this bill &mdash; you'll find them on the same page.`
      : "";

  let subject: string;
  let heading: string;
  let body1: string;
  if (isDeadline) {
    subject = isFinal ? `Last call on your ${label} deadline` : `Your ${label} deadline is coming up`;
    heading = isFinal ? "Your deadline is here" : "The response window is closing";
    // The cron sends any row with due_date <= today, so a delayed or backed-up
    // final can land AFTER the deadline — tense guard, not a new claim.
    const closed = deadlineOn ? isPastDate(params.governingDeadlineDate!) : false;
    if (isFinal) {
      body1 = closed
        ? `The response window on your ${label} closed on ${deadlineOn}.`
        : `The response window on your ${label} closes on ${deadlineOn}. If you still haven't heard back, your final follow-up letter is ready to send.`;
    } else {
      body1 = `Your ${label} went out on ${sentOn}, and the response window closes on ${deadlineOn}. If they haven't answered yet, a follow-up letter is ready to send.`;
    }
  } else {
    subject = `Checking in on your ${label}`;
    heading = "Did you hear back?";
    body1 = sentOn
      ? `Your ${label} went out on ${sentOn}. This is when responses usually arrive. If you haven't heard back, there are steps you can take now.`
      : `This is when responses to your ${label} usually arrive. If you haven't heard back, there are steps you can take now.`;
  }
  const body2 = isDeadline
    ? "Open your claim to log a response, or send the follow-up."
    : "Open your claim to log what happened, or pick up your next steps if you're still waiting.";

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #111827; font-size: 18px;">${heading}</h2>
      <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
        ${body1}
      </p>
      <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
        ${body2}
      </p>
      <a href="${claimUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; margin-top: 8px;">
        Open your claim
      </a>
      ${contextLine ? `
      <p style="color: #9ca3af; font-size: 12px; margin-top: 16px;">
        ${contextLine}
      </p>
      ` : ""}
      ${followupType === "final" ? `
      <p style="color: #9ca3af; font-size: 12px; margin-top: 16px;">
        This is our last automatic reminder for this letter &mdash; you can always update it from
        your claim page.
      </p>
      ` : ""}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="color: #9ca3af; font-size: 11px;">
        Candid is an Airgetlam Labs LLC company. You're receiving this because you filed a dispute through Candid.
      </p>
    </div>
  `;

  await sendEmail({ to: userEmail, subject, html });

  // Slack notification (admin visibility)
  await sendSlack({
    text: `Dispute follow-up sent: ${label} ($${amountDisputed}) — ${daysAgo} days`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Dispute Follow-up Sent" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Type:* ${label}` },
          { type: "mrkdwn", text: `*Amount:* $${amountDisputed.toLocaleString()}` },
          { type: "mrkdwn", text: `*Days since filed:* ${daysAgo}` },
          { type: "mrkdwn", text: `*Follow-up:* ${followupType}` },
          { type: "mrkdwn", text: `*User:* ${userEmail}` },
        ],
      },
    ],
  });
}

/**
 * Send a denial escalation notification — recommends Candid Case.
 */
export async function notifyDenialEscalation(params: {
  userEmail: string;
  disputeType: string;
  amountDisputed: number;
  insurerName?: string;
}): Promise<void> {
  const { userEmail, disputeType, amountDisputed, insurerName } = params;
  const typeLabel = disputeType.replace(/_/g, " ");

  const subject = "Your dispute was denied — here's what you can do next";
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #111827; font-size: 18px;">Your dispute was denied</h2>
      <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
        Your ${typeLabel} dispute${insurerName ? ` against ${insurerName}` : ""} for
        <strong>$${amountDisputed.toLocaleString()}</strong> was denied. But you have options:
      </p>
      <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="color: #1e40af; font-size: 14px; font-weight: 600; margin: 0 0 8px;">
          Submit to Candid Case — included with Candid Pro
        </p>
        <p style="color: #3b82f6; font-size: 13px; margin: 0;">
          Connect with a lawyer who specializes in insurance disputes. No additional charge with your subscription.
        </p>
      </div>
      <a href="${APP_URL}/case" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">
        Explore your options
      </a>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="color: #9ca3af; font-size: 11px;">
        Candid is an Airgetlam Labs LLC company.
      </p>
    </div>
  `;

  await sendEmail({ to: userEmail, subject, html });
}

/**
 * T2.2 v3: Slack admin alert when a dispute outcome is quarantined per Pattern 1 #13
 * outlier evaluation (amount_recovered ≥ threshold OR > multiplier × amount_disputed).
 *
 * Admin reviews quarantined rows + can release via flywheel_eligibility_status update
 * to 'verified_via_admin' (per [[Candid_Data_Principles]] §6 #13 quarantine state machine).
 */
export async function notifyOutlierQuarantine(params: {
  disputeId: string;
  amountRecovered: number;
  amountDisputed: number;
  reason: string;
}): Promise<void> {
  const { disputeId, amountRecovered, amountDisputed, reason } = params;

  await sendSlack({
    text: `🚨 Outlier dispute quarantined — admin review needed`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*🚨 Pattern 1 #13 outlier quarantine fired*\n` +
            `Dispute \`${disputeId}\` quarantined from cross-user aggregates.\n\n` +
            `*Reason:* ${reason}\n` +
            `*amount_recovered:* $${amountRecovered.toLocaleString()}\n` +
            `*amount_disputed:* $${amountDisputed.toLocaleString()}\n\n` +
            `Review in \`/admin/claims\` — dispute flagged flywheel_eligibility_status=quarantined_outlier. ` +
            `Release via update to 'verified_via_admin' if legitimate.`,
        },
      },
    ],
  });
}
