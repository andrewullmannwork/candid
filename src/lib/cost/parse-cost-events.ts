/**
 * parse_cost_events ledger writer (Cost-F, S129).
 *
 * Single insertion point for "I just spent Haiku money parsing something."
 * Every cost-emitting path (SBC base, EOC base, plan-doc, reparse single,
 * reparse batch, future card scan / bill parse) calls recordCostEvent
 * exactly once per parse.
 *
 * Non-fatal — telemetry failure NEVER blocks the parse itself.
 *
 * Read path is Cost-F's /api/admin/cost-per-canonical aggregator;
 * see src/lib/cost/cost-per-canonical.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ParserKind =
  | "sbc_base"
  | "eoc_base"
  | "plan_doc_base"
  | "reparse_field"
  | "reparse_field_batch"
  | "card_scan"
  | "bill_parse"
  | "eob_parse";

export type CostSource =
  | "user_upload"
  | "auto_reparse"
  | "admin_action"
  | "cf40_v4_layer5"
  | "cf44_self_check";

export interface ParseCostEvent {
  canonicalPlanId?: string | null;
  insurancePlanId?: string | null;
  documentId?: string | null;
  userId?: string | null;
  parserKind: ParserKind;
  costSource: CostSource;
  costUsd: number;
  haikuTokensInput?: number | null;
  haikuTokensOutput?: number | null;
  haikuCacheReadTokens?: number | null;
  haikuCacheCreateTokens?: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert one row into parse_cost_events. Non-fatal on error (logs warning,
 * returns void). Callers should NOT await this in latency-critical paths;
 * fire-and-forget is the typical pattern.
 *
 * Zero-cost short-circuit: if costUsd is 0, still records the row (useful
 * for "this parse happened but used cached responses" attribution). If
 * costUsd is negative or NaN, the insert is skipped with a warning.
 */
export async function recordCostEvent(
  supabase: SupabaseClient,
  event: ParseCostEvent,
): Promise<void> {
  if (!Number.isFinite(event.costUsd) || event.costUsd < 0) {
    console.warn(
      `[parse-cost-events] skipped invalid cost_usd=${event.costUsd} for parser_kind=${event.parserKind}`,
    );
    return;
  }

  try {
    const { error } = await supabase.from("parse_cost_events").insert({
      canonical_plan_id: event.canonicalPlanId ?? null,
      insurance_plan_id: event.insurancePlanId ?? null,
      document_id: event.documentId ?? null,
      user_id: event.userId ?? null,
      parser_kind: event.parserKind,
      cost_source: event.costSource,
      cost_usd: event.costUsd,
      haiku_tokens_input: event.haikuTokensInput ?? null,
      haiku_tokens_output: event.haikuTokensOutput ?? null,
      haiku_cache_read_tokens: event.haikuCacheReadTokens ?? 0,
      haiku_cache_create_tokens: event.haikuCacheCreateTokens ?? 0,
      metadata: event.metadata ?? null,
    });

    if (error) {
      console.warn(
        `[parse-cost-events] insert failed (non-fatal): ${error.message}`,
      );
    }
  } catch (err) {
    console.warn(
      `[parse-cost-events] unexpected error (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
