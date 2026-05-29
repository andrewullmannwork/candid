/**
 * PR4 (S142) Slack notifier for bill_parser_decisions fire verdicts.
 *
 * Mirrors the truncation-telemetry.ts pattern (Bills-E.1 / S133): pure
 * builders + non-fatal chat.postMessage POST with SLACK_BOT_TOKEN env +
 * SLACK_BACKEND_OPS_CHANNEL_ID env override (default C0B6XUUD3NU, shared
 * with Cost-F + Bills-E.1).
 *
 * Fires on verdicts: sign_violation, header_reconciliation_failed, multi.
 * Does NOT fire on:
 *   - clean (silent — no noise)
 *   - per_line_sparse (today's PROD baseline per S139 finding; firing on
 *     every sparse upload would drown the channel until B-1 tool-use lands)
 *
 * Failure modes (non-fatal — never throws):
 * - SLACK_BOT_TOKEN unset: skip Slack, log warning, return cleanly
 * - Slack API error: log + swallow (DB row already written upstream)
 */

const SLACK_API_BASE = "https://slack.com/api";
// PR4 (S142) — bill_parser_decisions Slack alerts go to a DEDICATED channel
// (not shared with Cost-F + Bills-E.1 alerts which use C0B6XUUD3NU via
// truncation-telemetry's SLACK_BACKEND_OPS_CHANNEL_ID). Keeps PR4 fire
// signal cleanly separated from spend / parse-truncation alerts.
const DEFAULT_SLACK_CHANNEL_ID = "C0B6EMR0AET";
const DEFAULT_ADMIN_URL_BASE = "https://www.candidclaim.com";

function resolveAdminUrlBase(): string {
  return process.env.APP_BASE_URL ?? DEFAULT_ADMIN_URL_BASE;
}

const NOTIFIABLE_VERDICTS = new Set([
  "sign_violation",
  "header_reconciliation_failed",
  "multi",
]);

export interface BillParserNotifyPayload {
  decisionId: string;
  verdict: string;
  parserPath: "raw_json" | "tool_use";
  documentId: string | null;
  claimId: string | null;
  userId: string | null;
  signViolationFields: string[] | null;
  headerReconciliationDelta: number | null;
  headerReconciliationTolerance: number | null;
  perLineFailingFields: string[]; // populated-but-mismatch field names
  totalBilled: number | null;
  billType: "eob" | "itemized_bill" | null;
}

export function shouldNotify(verdict: string): boolean {
  return NOTIFIABLE_VERDICTS.has(verdict);
}

export function resolveSlackChannelId(): string {
  // Dedicated env var (NOT SLACK_BACKEND_OPS_CHANNEL_ID — that one routes
  // truncation-telemetry + Cost-F to C0B6XUUD3NU and must stay untouched).
  return process.env.SLACK_BILL_PARSER_CHANNEL_ID ?? DEFAULT_SLACK_CHANNEL_ID;
}

export function buildAdminDeepLink(decisionId: string): string {
  return `${resolveAdminUrlBase()}/admin/review-queue#bill-decision-${decisionId}`;
}

export function buildSlackMessageText(payload: BillParserNotifyPayload): string {
  const emojiByVerdict: Record<string, string> = {
    sign_violation: ":rotating_light:",
    header_reconciliation_failed: ":warning:",
    multi: ":fire:",
  };
  const emoji = emojiByVerdict[payload.verdict] ?? ":mag:";
  const titleByVerdict: Record<string, string> = {
    sign_violation: "Bill parser sign-violation",
    header_reconciliation_failed: "Bill parser header reconciliation failed",
    multi: "Bill parser multi-verdict",
  };
  const title = titleByVerdict[payload.verdict] ?? `Bill parser fire (${payload.verdict})`;

  const lines: string[] = [
    `${emoji} *${title}*`,
    ``,
    `decision_id: \`${payload.decisionId}\``,
    `parser_path: \`${payload.parserPath}\``,
    `verdict: \`${payload.verdict}\``,
    `bill_type: ${payload.billType ?? "—"}`,
    `total_billed: ${payload.totalBilled != null ? `$${payload.totalBilled.toFixed(2)}` : "—"}`,
  ];
  if (payload.documentId) lines.push(`document_id: \`${payload.documentId}\``);
  if (payload.claimId) lines.push(`claim_id: \`${payload.claimId}\``);
  if (payload.userId) lines.push(`user_id: \`${payload.userId}\``);
  if (payload.signViolationFields && payload.signViolationFields.length > 0) {
    lines.push(`sign_violation_fields: \`${payload.signViolationFields.join(", ")}\``);
  }
  if (payload.perLineFailingFields.length > 0) {
    lines.push(`per_line_failing_fields: \`${payload.perLineFailingFields.join(", ")}\``);
  }
  if (payload.headerReconciliationDelta != null) {
    lines.push(
      `header_reconciliation_delta: $${payload.headerReconciliationDelta.toFixed(2)} (tolerance $${(payload.headerReconciliationTolerance ?? 0).toFixed(2)})`,
    );
  }
  lines.push(``);
  lines.push(`→ Review at ${buildAdminDeepLink(payload.decisionId)}`);
  return lines.join("\n");
}

/**
 * Fire a Slack chat.postMessage for a bill-parser violation. Non-fatal: never
 * throws. Caller should `void` the promise — failures are logged but not
 * propagated.
 */
export async function notifyBillParserViolation(
  payload: BillParserNotifyPayload,
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (!shouldNotify(payload.verdict)) return;

  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn(
      `[bill-parser-slack] SLACK_BOT_TOKEN not set; notification skipped (decision_id=${payload.decisionId} verdict=${payload.verdict})`,
    );
    return;
  }

  const channelId = resolveSlackChannelId();
  const text = buildSlackMessageText(payload);
  const fetchFn = fetchImpl ?? fetch;

  try {
    const res = await fetchFn(`${SLACK_API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: channelId,
        text,
        mrkdwn: true,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      console.warn(
        `[bill-parser-slack] chat.postMessage failed: http=${res.status} slack_error=${data.error ?? "unknown"} (decision_id=${payload.decisionId})`,
      );
    }
  } catch (err) {
    console.warn(
      `[bill-parser-slack] post threw (non-fatal): ${err instanceof Error ? err.message : String(err)} (decision_id=${payload.decisionId})`,
    );
  }
}
