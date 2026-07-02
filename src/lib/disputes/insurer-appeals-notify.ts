/**
 * Insurer appeals-address proposal — admin Slack notification (dispute-letters v2 S3).
 *
 * A user-supplied appeals-address correction (or a doc-extraction conflict) queues a
 * row in `insurer_appeals_proposed_changes` for admin review at /admin/insurer-appeals.
 * That queue was SILENT — proposals piled up until an admin happened to check the page.
 * This fires a real-time Slack ping with clear instructions so the admin knows to act.
 *
 * Deliberately SIMPLE (vs canonical-promotion-notifications.ts): fire-and-log, NO DB
 * write-back, NO retry cron, NO migration. Rationale — the admin QUEUE is the durable
 * record: if Slack delivery fails, the proposal still sits visibly in the queue, so
 * nothing is lost. Slack is only the nudge. Fail-soft: never throws, never blocks the
 * caller (the user's own letter already uses their address regardless).
 *
 * Note: the appeals address is the INSURER's business address, not user PII; the only
 * user-linked field surfaced is the source label ("user correction" / "doc extraction").
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://candidclaim.com";
const ADMIN_QUEUE_PATH = "/admin/insurer-appeals";

export interface AppealsAddressParts {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
}

export interface InsurerAppealsProposalPayload {
  insurerName: string;
  /** which pipeline queued the proposal — the only user-linked datum we surface. */
  source: "user_correction" | "doc_extraction";
  /** the shared-catalog address today (null = none on file yet). */
  current: AppealsAddressParts | null;
  /** the address the submitter/extractor proposes. */
  proposed: AppealsAddressParts;
}

const SOURCE_LABEL: Record<InsurerAppealsProposalPayload["source"], string> = {
  user_correction: "User correction",
  doc_extraction: "Document-extraction conflict",
};

/** One-line, human-readable rendering of an appeals address for the Slack fields. */
export function formatAppealsAddressOneLine(a: AppealsAddressParts | null): string {
  if (!a) return "— none on file —";
  const cityStateZip = [[a.city, a.state].filter(Boolean).join(", "), a.postalCode].filter(Boolean).join(" ");
  const base = [a.addressLine1, a.addressLine2, cityStateZip].filter(Boolean).join(", ");
  if (!base) return "— (empty) —";
  return a.phone ? `${base} · ${a.phone}` : base;
}

/** Pure formatter → Slack Block Kit payload. No env/network → unit-testable. */
export function formatInsurerAppealsProposalSlack(
  payload: InsurerAppealsProposalPayload,
): Record<string, unknown> {
  const { insurerName, source, current, proposed } = payload;
  return {
    text: `Insurer appeals address — review needed: ${insurerName}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Insurer appeals address — review needed" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Insurer:*\n${insurerName}` },
          { type: "mrkdwn", text: `*Source:*\n${SOURCE_LABEL[source]}` },
          { type: "mrkdwn", text: `*Current on file:*\n${formatAppealsAddressOneLine(current)}` },
          { type: "mrkdwn", text: `*Proposed:*\n${formatAppealsAddressOneLine(proposed)}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*What to do:* open the queue and *Accept* (writes this address to the shared insurer catalog — used across every plan under this insurer, for all users) or *Reject* (keeps the current address). The submitter's own letter already uses their address; this only affects the shared catalog.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open admin queue" },
            url: `${APP_URL}${ADMIN_QUEUE_PATH}`,
            style: "primary",
          },
        ],
      },
    ],
  };
}

/**
 * Fire-and-log Slack send. Returns {ok,error}; NEVER throws (fetch errors are caught).
 * No-ops safely when SLACK_WEBHOOK_URL is unset (dev) or a placeholder (CI).
 */
export async function notifyInsurerAppealsProposal(
  payload: InsurerAppealsProposalPayload,
): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return { ok: false, error: "SLACK_WEBHOOK_URL not configured" };
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formatInsurerAppealsProposalSlack(payload)),
    });
    if (!response.ok) return { ok: false, error: `${response.status} ${response.statusText}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
