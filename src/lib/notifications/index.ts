/**
 * Notification system for Candid
 * All notifications route through Slack webhook. No email (Resend) notifications.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://candidclaim.com";

// ── Slack helper ────────────────────────────────────────────────────────────

async function sendSlack(payload: Record<string, unknown>): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[notifications] SLACK_WEBHOOK_URL not configured — skipping");
    return;
  }
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[notifications] Slack webhook failed:", err);
  }
}

// ── Admin notifications ─────────────────────────────────────────────────────

export async function notifyAdminForReview(
  documentId: string,
  classifiedType: string,
  confidence: number,
  fileName: string,
  userEmail: string
): Promise<void> {
  await sendSlackReview(documentId, classifiedType, confidence, fileName, userEmail);
}

async function sendSlackReview(
  _documentId: string,
  classifiedType: string,
  confidence: number,
  fileName: string,
  userEmail: string
): Promise<void> {
  const confidencePct = Math.round(confidence * 100);

  await sendSlack({
    text: `Document Review Required: ${fileName} (${confidencePct}% confidence)`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Document Review Required" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*File:* ${fileName}` },
          { type: "mrkdwn", text: `*Type:* ${classifiedType}` },
          { type: "mrkdwn", text: `*Confidence:* ${confidencePct}%` },
          { type: "mrkdwn", text: `*User:* ${userEmail}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Review in Admin Panel" },
            url: `${APP_URL}/admin/documents/review`,
            style: "primary",
          },
        ],
      },
    ],
  });
}

// ── User notifications (now via Slack to admin) ─────────────────────────────

export async function notifyUserPendingReview(
  userEmail: string,
  fileName: string
): Promise<void> {
  await sendSlack({
    text: `User document pending review: ${fileName}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "User Document Pending Review" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${userEmail}* uploaded *${fileName}* — needs manual review.\nUser sees "under review" status on their upload page.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Review Documents" },
            url: `${APP_URL}/admin/documents/review`,
            style: "primary",
          },
        ],
      },
    ],
  });
}

/** Notify admin that new services landed in "other" category and need review */
export async function notifyUncategorizedServices(
  slugs: string[]
): Promise<void> {
  if (slugs.length === 0) return;

  await sendSlack({
    text: `New uncategorized services need review`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "New Uncategorized Services" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${slugs.length} service(s) were auto-created with category "other" and need re-categorization:\n${slugs.map(s => `• \`${s}\` — ${s.replace(/_/g, " ")}`).join("\n")}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Review in Admin" },
            url: `${APP_URL}/admin/pipeline#services`,
          },
        ],
      },
    ],
  });
}

// ── Processing budget alerts ────────────────────────────────────────────────

/**
 * Check if a budget threshold was crossed and send a Slack alert.
 * Thresholds: 50%, 60%, 70%, 80%, 85%, 90%, 95%, 100%+
 * Alerts once per threshold per budget type per day.
 */
const THRESHOLDS = [50, 60, 70, 80, 85, 90, 95, 100];
const alertedThresholds = new Map<string, Set<number>>();

export async function notifyBudgetThreshold(
  used: number,
  limit: number,
  budgetType: "daily" | "monthly"
): Promise<void> {
  if (limit <= 0) return;

  const pct = Math.round((used / limit) * 100);
  const key = `${budgetType}_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}`;

  if (!alertedThresholds.has(key)) {
    alertedThresholds.set(key, new Set());
  }
  const alerted = alertedThresholds.get(key)!;

  // Find the highest threshold crossed
  const crossedThresholds = THRESHOLDS.filter(t => pct >= t && !alerted.has(t));
  if (crossedThresholds.length === 0) return;

  // Alert for the highest newly crossed threshold
  const threshold = Math.max(...crossedThresholds);
  crossedThresholds.forEach(t => alerted.add(t));

  const isOverLimit = pct >= 100;
  const emoji = isOverLimit ? ":rotating_light:" : pct >= 90 ? ":warning:" : ":bar_chart:";
  const label = budgetType === "daily" ? "Daily" : "Monthly";

  await sendSlack({
    text: `${emoji} ${label} OCR budget at ${pct}% (${used}/${limit} pages)`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji} ${label} OCR Budget: ${pct}%` },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Used:* ${used} pages` },
          { type: "mrkdwn", text: `*Limit:* ${limit} pages` },
          { type: "mrkdwn", text: `*Remaining:* ${Math.max(0, limit - used)} pages` },
          { type: "mrkdwn", text: `*Status:* ${isOverLimit ? "LIMIT REACHED" : `${pct}% consumed`}` },
        ],
      },
      ...(isOverLimit ? [{
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: `:no_entry: New uploads will be queued until the ${budgetType} limit resets. Increase the limit in admin settings or wait for the reset.`,
        },
      }] : []),
    ],
  });
}

