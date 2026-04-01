/**
 * Notification system for Candid
 * - Admin notifications: email (Resend) + Slack webhook
 * - User notifications: email (Resend)
 */

import { Resend } from "resend";

function getResend(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey === "re_PLACEHOLDER") {
    console.warn("[notifications] Resend API key not configured — emails will be skipped");
    return null as unknown as Resend;
  }
  return new Resend(apiKey);
}

const FROM_EMAIL = "Candid <noreply@candidclaim.com>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://candidclaim.com";

// ── Admin notifications ─────────────────────────────────────────────────────

export async function notifyAdminForReview(
  documentId: string,
  classifiedType: string,
  confidence: number,
  fileName: string,
  userEmail: string
): Promise<void> {
  await Promise.allSettled([
    sendAdminEmail(documentId, classifiedType, confidence, fileName, userEmail),
    sendSlackWebhook(documentId, classifiedType, confidence, fileName, userEmail),
  ]);
}

async function sendAdminEmail(
  documentId: string,
  classifiedType: string,
  confidence: number,
  fileName: string,
  userEmail: string
): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  const adminEmail = process.env.ADMIN_EMAIL || "andrew@candidclaim.com";
  const confidencePct = Math.round(confidence * 100);

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: adminEmail,
      subject: `[Review Required] ${fileName} (${confidencePct}% confidence)`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px;">
          <h2 style="margin: 0 0 16px;">Document Review Required</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">File</td><td style="padding: 8px 0; font-size: 14px; font-weight: 600;">${fileName}</td></tr>
            <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Classified as</td><td style="padding: 8px 0; font-size: 14px;">${classifiedType}</td></tr>
            <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Confidence</td><td style="padding: 8px 0; font-size: 14px; color: ${confidencePct >= 60 ? '#d97706' : '#dc2626'};">${confidencePct}%</td></tr>
            <tr><td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Uploaded by</td><td style="padding: 8px 0; font-size: 14px;">${userEmail}</td></tr>
          </table>
          <a href="${APP_URL}/admin/documents?review=${documentId}"
             style="display: inline-block; margin-top: 16px; padding: 10px 20px; background: #2563eb; color: white; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">
            Review Document
          </a>
        </div>
      `,
    });
  } catch (err) {
    console.error("[notifications] Admin email failed:", err);
  }
}

async function sendSlackWebhook(
  documentId: string,
  classifiedType: string,
  confidence: number,
  fileName: string,
  userEmail: string
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const confidencePct = Math.round(confidence * 100);

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
                url: `${APP_URL}/admin/documents?review=${documentId}`,
                style: "primary",
              },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    console.error("[notifications] Slack webhook failed:", err);
  }
}

// ── User notifications ──────────────────────────────────────────────────────

export async function notifyUserPendingReview(
  userEmail: string,
  fileName: string
): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: userEmail,
      subject: "We're reviewing your document",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px;">
          <p>Hi,</p>
          <p>Thanks for uploading <strong>${fileName}</strong>. We weren't able to verify it automatically, so our team will take a look.</p>
          <p>This usually takes less than 24 hours. We'll email you as soon as your document has been reviewed and your benefits are ready.</p>
          <p>If you have a different version of this document (like a PDF instead of a photo, or your Summary of Benefits and Coverage), you can upload that in the meantime for faster results.</p>
          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
            &mdash; The Candid Team<br/>
            <a href="${APP_URL}" style="color: #2563eb;">candidclaim.com</a>
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[notifications] User pending review email failed:", err);
  }
}

/** Notify admin that new services landed in "other" category and need review */
export async function notifyUncategorizedServices(
  slugs: string[]
): Promise<void> {
  if (slugs.length === 0) return;

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
                url: `${APP_URL}/admin/pipeline`,
              },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    console.error("[notifications] Uncategorized services Slack failed:", err);
  }
}

export async function notifyUserDocumentApproved(
  userEmail: string,
  fileName: string
): Promise<void> {
  const resend = getResend();
  if (!resend) return;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: userEmail,
      subject: "Your document has been processed",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px;">
          <p>Hi,</p>
          <p>Great news &mdash; <strong>${fileName}</strong> has been reviewed and processed. Your benefits are now updated with the details from your plan.</p>
          <p>
            <a href="${APP_URL}/plan"
               style="display: inline-block; margin-top: 8px; padding: 10px 20px; background: #2563eb; color: white; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">
              View Your Benefits
            </a>
          </p>
          <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
            &mdash; The Candid Team<br/>
            <a href="${APP_URL}" style="color: #2563eb;">candidclaim.com</a>
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[notifications] User approval email failed:", err);
  }
}
