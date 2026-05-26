/**
 * Bills-E.1 telemetry (S133) — record very-large-bill parse failures.
 *
 * When haiku-bill-parser retries at HAIKU_MAX_OUTPUT (32K) and the response
 * STILL terminates with stop_reason="max_tokens", the parse returns null
 * (total failure; user gets zero extraction data). Before that null return,
 * this module captures the event to documents.metadata.bill_truncation +
 * fires a Slack alert so operators can surface the upload for admin review.
 *
 * This is an OBSERVABILITY patch, not a fix. The real fix (Pattern P-Q
 * section discovery + line-item chunking on very-large bills) is deferred
 * to Phase 2+ pending PROD data on actual truncation frequency. See
 * plans/pre_launch_backend_hardening.md §5 Bills-E.1 for the deferred
 * trigger ("re-open if PROD truncation rate >0.1% in first 90d post-launch
 * OR if this telemetry fires >=3 times in any 7-day window pre-launch").
 *
 * Failure modes (non-fatal — never throws):
 * - Supabase write fails: logged + skipped; Slack alert still fires
 * - Slack post fails: logged + skipped; Supabase write still persists
 * - SLACK_BOT_TOKEN unset: Slack skipped + logged (still records to DB)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_SLACK_CHANNEL_ID = "C0B6XUUD3NU"; // Andrew-confirmed channel (shared with Cost-F)
const ADMIN_URL_BASE = "https://www.candidclaim.com";

export interface BillTruncationEvent {
  fired_at: string;
  billType: "eob" | "itemized_bill";
  userId: string;
  stop_reason: "max_tokens";
  input_tokens_estimate: number;
  max_tokens_attempted: number;
  ocr_text_length: number;
  outcome: "total_parse_failure";
}

export interface RecordBillTruncationArgs {
  documentId: string;
  userId: string;
  billType: "eob" | "itemized_bill";
  inputTokensEstimate: number;
  maxTokensAttempted: number;
  ocrTextLength: number;
  /** Optional injected client for testing; defaults to lazy createServerClient. */
  supabase?: SupabaseClient;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
  /** Optional clock override for testing. */
  now?: () => Date;
}

/**
 * Build the structured telemetry payload. Pure — no I/O. Testable.
 */
export function buildTruncationPayload(args: {
  billType: "eob" | "itemized_bill";
  userId: string;
  inputTokensEstimate: number;
  maxTokensAttempted: number;
  ocrTextLength: number;
  now?: () => Date;
}): BillTruncationEvent {
  const clock = args.now ?? (() => new Date());
  return {
    fired_at: clock().toISOString(),
    billType: args.billType,
    userId: args.userId,
    stop_reason: "max_tokens",
    input_tokens_estimate: args.inputTokensEstimate,
    max_tokens_attempted: args.maxTokensAttempted,
    ocr_text_length: args.ocrTextLength,
    outcome: "total_parse_failure",
  };
}

/**
 * Build Slack message text. Pure — no I/O. Testable.
 */
export function buildSlackMessageText(
  documentId: string,
  payload: BillTruncationEvent,
): string {
  const adminUrl = `${ADMIN_URL_BASE}/admin/parse-audit-runs`;
  return [
    `:warning: *Bill parse truncated at 32K cap (total parse failure)*`,
    ``,
    `documentId: \`${documentId}\``,
    `userId: \`${payload.userId}\``,
    `billType: \`${payload.billType}\``,
    `input_tokens_estimate: ${payload.input_tokens_estimate.toLocaleString()}`,
    `max_tokens_attempted: ${payload.max_tokens_attempted.toLocaleString()}`,
    `ocr_text_length: ${payload.ocr_text_length.toLocaleString()} chars`,
    `fired_at: ${payload.fired_at}`,
    ``,
    `→ User got zero extraction data. Review at ${adminUrl}`,
    `→ See plans/pre_launch_backend_hardening.md §5 Bills-E.1 for the deferred chunking fix trigger.`,
  ].join("\n");
}

/**
 * Resolve Slack channel ID with env override.
 * Per Ship Gate G6 (Cap/Threshold Tunability): channel ID tunable via
 * SLACK_BACKEND_OPS_CHANNEL_ID env var (no code deploy needed to redirect).
 */
export function resolveSlackChannelId(): string {
  return process.env.SLACK_BACKEND_OPS_CHANNEL_ID ?? DEFAULT_SLACK_CHANNEL_ID;
}

/**
 * Record a truncation event:
 * 1. UPDATE documents.metadata.bill_truncation via read-spread-write
 * 2. POST to Slack chat.postMessage with structured message
 *
 * Non-fatal: catches all errors + logs. Never throws. Designed to be
 * called from haiku-bill-parser.ts right before the truncation return null
 * so the parse failure path remains intact.
 */
export async function recordBillTruncation(
  args: RecordBillTruncationArgs,
): Promise<void> {
  const payload = buildTruncationPayload({
    billType: args.billType,
    userId: args.userId,
    inputTokensEstimate: args.inputTokensEstimate,
    maxTokensAttempted: args.maxTokensAttempted,
    ocrTextLength: args.ocrTextLength,
    now: args.now,
  });

  // 1. Persist to documents.metadata via read-spread-write
  try {
    const supabase = args.supabase ?? (await loadSupabaseClient());
    if (supabase) {
      // Read existing metadata (avoid clobbering Ing-H column_wrap_decision etc.)
      const { data: existing, error: readErr } = await supabase
        .from("documents")
        .select("metadata")
        .eq("id", args.documentId)
        .maybeSingle();
      if (readErr) {
        console.warn(
          `[bill-truncation-telemetry] failed to read documents.metadata for ${args.documentId}: ${readErr.message}`,
        );
      } else {
        const existingMetadata = (existing?.metadata ?? {}) as Record<string, unknown>;
        const nextMetadata = { ...existingMetadata, bill_truncation: payload };
        const { error: writeErr } = await supabase
          .from("documents")
          .update({ metadata: nextMetadata })
          .eq("id", args.documentId);
        if (writeErr) {
          console.warn(
            `[bill-truncation-telemetry] failed to write documents.metadata.bill_truncation for ${args.documentId}: ${writeErr.message}`,
          );
        }
      }
    }
  } catch (err) {
    console.warn(
      `[bill-truncation-telemetry] documents.metadata write threw for ${args.documentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 2. Slack alert
  try {
    await fireSlackAlert(args.documentId, payload, args.fetchImpl);
  } catch (err) {
    console.warn(
      `[bill-truncation-telemetry] Slack alert threw for ${args.documentId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function loadSupabaseClient(): Promise<SupabaseClient | null> {
  try {
    const mod = await import("@/lib/supabase/server");
    return mod.createServerClient();
  } catch (err) {
    console.warn(
      `[bill-truncation-telemetry] failed to load Supabase server client: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

async function fireSlackAlert(
  documentId: string,
  payload: BillTruncationEvent,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.warn(
      `[bill-truncation-telemetry] SLACK_BOT_TOKEN not set; telemetry recorded but Slack delivery skipped (documentId=${documentId})`,
    );
    return;
  }

  const channelId = resolveSlackChannelId();
  const text = buildSlackMessageText(documentId, payload);
  const fetchFn = fetchImpl ?? fetch;

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

  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!res.ok || !data.ok) {
    console.warn(
      `[bill-truncation-telemetry] Slack chat.postMessage failed: http=${res.status} slack_error=${
        data.error ?? "unknown"
      } (documentId=${documentId})`,
    );
  }
}
