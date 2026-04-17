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

// ── Follow-up notifications ─────────────────────────────────────────────────

/**
 * Send a follow-up notification for a dispute that's been open for 30+ days.
 */
export async function notifyDisputeFollowup(params: {
  userEmail: string;
  disputeId: string;
  disputeType: string;
  amountDisputed: number;
  filedDate: string;
  followupType: string;
  insurerName?: string;
}): Promise<void> {
  const { userEmail, disputeId, disputeType, amountDisputed, filedDate, followupType, insurerName } = params;
  const daysAgo = Math.floor((Date.now() - new Date(filedDate).getTime()) / (1000 * 60 * 60 * 24));
  const claimUrl = `${APP_URL}/claim`;
  const typeLabel = disputeType.replace(/_/g, " ");

  // Email notification
  const subject = `Your ${typeLabel} dispute — ${daysAgo} days and counting`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #111827; font-size: 18px;">What happened with your dispute?</h2>
      <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
        Your ${typeLabel} dispute${insurerName ? ` against ${insurerName}` : ""} for
        <strong>$${amountDisputed.toLocaleString()}</strong> was filed ${daysAgo} days ago.
      </p>
      <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
        Log in to Candid to update the outcome. This helps us improve our audit accuracy
        and helps other users on your plan.
      </p>
      <a href="${claimUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; margin-top: 8px;">
        Update dispute outcome
      </a>
      ${followupType === "final" ? `
      <p style="color: #9ca3af; font-size: 12px; margin-top: 16px;">
        This is our last reminder. You can always update your dispute outcome from the Claim page.
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
    text: `Dispute follow-up sent: ${typeLabel} ($${amountDisputed}) — ${daysAgo} days`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Dispute Follow-up Sent" } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Type:* ${typeLabel}` },
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
