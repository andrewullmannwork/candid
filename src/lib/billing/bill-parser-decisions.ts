/**
 * Bill parser persist-time decisions event-log writer (PR4 / S142).
 *
 * Non-fatal append-only writer to `bill_parser_decisions` (mig 133). One row
 * per persistAuditResults invocation; verdict captures B-1 (per-line sparse),
 * B-2 (header reconciliation), B-3 (sign violation) outcomes, including the
 * "clean" non-fire path so Ship Gate G7 silent-regression detection can
 * surface verdict-rate drift.
 *
 * Matches the mig 124 canonical_match_decisions pattern: server-only writes,
 * no RLS, no FKs to documents/claims/users (telemetry survives deletion),
 * failures swallowed via try/catch so persist hot path is never blocked.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SignViolationDetail,
  PerLineSumVerdict,
  HeaderReconciliationVerdict,
} from "./sum-invariants";
import { notifyBillParserViolation, shouldNotify } from "./bill-parser-slack";

export type BillParserVerdict =
  | "clean"
  | "sign_violation"
  | "per_line_sparse"
  | "header_reconciliation_failed"
  // S304 — the CHARGES column doesn't sum to the bill's own total. A different
  // problem from `per_line_sparse` ("the adjudication breakdown is unreliable,
  // pro-rate from the header") and it wants a different response: look for a
  // duplicate, a phantom charge, an omitted service, or a line we misread.
  | "billed_sum_mismatch"
  | "multi";

export type BillParserPath = "raw_json" | "tool_use";

export interface RecordBillParserDecisionParams {
  /** S304 — the audit concluded the DOCUMENT is at fault; see computeVerdict. */
  documentArithmeticFinding?: boolean;
  supabase: SupabaseClient;
  documentId?: string | null;
  claimId?: string | null;
  userId?: string | null;
  parserPath: BillParserPath;
  signViolations: SignViolationDetail[];
  perLineVerdicts: PerLineSumVerdict[];
  headerVerdict: HeaderReconciliationVerdict;
  // Optional context fields routed to metadata JSONB.
  metadata?: Record<string, unknown>;
}

/**
 * Compute the verdict label for the decision row from the verifier outputs.
 * `multi` fires when ≥2 distinct verdict categories trigger.
 */
export function computeVerdict(
  signViolations: SignViolationDetail[],
  perLineVerdicts: PerLineSumVerdict[],
  headerVerdict: HeaderReconciliationVerdict,
  /**
   * S304 — the audit already concluded the DOCUMENT's arithmetic is at fault
   * (an `unallocated_balance` finding via the identity path, which fires only
   * once the per-line charges are proven to sum to the bill's own total).
   *
   * This verdict drives the Slack alert and the admin review queue, both of
   * which mean "our PARSE needs a human". When the parse is verified against the
   * document and the document contradicts itself, paging engineering is wrong —
   * the user gets a finding instead.
   *
   * Passed IN rather than re-derived: persist already computes it from the
   * audit's finding, and this function deciding it independently is precisely
   * how the claim flag came to be suppressed while Slack still fired.
   */
  documentArithmeticFinding = false,
): { verdict: BillParserVerdict; categories: string[] } {
  const categories: string[] = [];
  if (signViolations.length > 0) categories.push("sign_violation");
  // Per-line violation = any populated DROPPABLE field whose sum doesn't match
  // header. Sparse-all-NULL is NOT a per-line violation (frontend Path B
  // fallback); sparse-with-some-populated-but-arithmetic-broken IS a violation.
  // S304 — `billed_amount` joined the verifier spec and is NOT droppable; it
  // carries its own category below rather than being read as a sparse
  // breakdown.
  const perLineViolation = perLineVerdicts.some(
    (v) => v.populated && !v.withinTolerance && v.droppable,
  );
  if (perLineViolation) categories.push("per_line_sparse");
  const billedVerdict = perLineVerdicts.find((v) => v.perLineKey === "billedAmount");
  if (billedVerdict && billedVerdict.populated && !billedVerdict.withinTolerance) {
    categories.push("billed_sum_mismatch");
  }
  if (
    headerVerdict.allHeaderTotalsPresent &&
    !headerVerdict.withinTolerance &&
    !documentArithmeticFinding
  ) {
    categories.push("header_reconciliation_failed");
  }
  if (categories.length === 0) return { verdict: "clean", categories };
  if (categories.length === 1) return { verdict: categories[0] as BillParserVerdict, categories };
  return { verdict: "multi", categories };
}

export async function recordBillParserDecision(
  params: RecordBillParserDecisionParams,
): Promise<void> {
  const {
    supabase,
    documentId,
    claimId,
    userId,
    parserPath,
    signViolations,
    perLineVerdicts,
    headerVerdict,
    metadata,
  } = params;

  const { verdict, categories } = computeVerdict(
    signViolations,
    perLineVerdicts,
    headerVerdict,
    params.documentArithmeticFinding ?? false,
  );

  const signViolationFields =
    signViolations.length > 0
      ? Array.from(new Set(signViolations.map((v) => v.field)))
      : null;

  const perLineSumDetails =
    perLineVerdicts.some((v) => v.populated && !v.withinTolerance) ||
    perLineVerdicts.some((v) => v.populated)
      ? perLineVerdicts
          .filter((v) => v.populated)
          .map((v) => ({
            field: v.field,
            line_sum: round2(v.lineSum),
            header: v.header != null ? round2(v.header) : null,
            delta: Number.isFinite(v.delta) ? round2(v.delta) : null,
            tolerance: round2(v.tolerance),
            within_tolerance: v.withinTolerance,
          }))
      : null;

  // Bound metadata size to avoid runaway JSONB growth. The application contract
  // documented in mig 133 says ≤4KB; enforce here.
  const mergedMetadata: Record<string, unknown> = {
    ...(metadata ?? {}),
    verdict_categories: categories,
    sign_violations:
      signViolations.length > 0
        ? signViolations.map((s) => ({
            field: s.field,
            value: round2(s.value),
            line_number: s.lineNumber ?? null,
          }))
        : [],
  };
  const metadataJson = bounded(mergedMetadata, 4000);

  let decisionId: string | null = null;
  try {
    const { data, error } = await supabase
      .from("bill_parser_decisions")
      .insert({
        document_id: documentId ?? null,
        claim_id: claimId ?? null,
        user_id: userId ?? null,
        verdict,
        sign_violation_fields: signViolationFields,
        per_line_sum_details: perLineSumDetails,
        header_reconciliation_delta:
          headerVerdict.allHeaderTotalsPresent && Number.isFinite(headerVerdict.delta)
            ? round2(headerVerdict.delta)
            : null,
        header_reconciliation_tolerance: headerVerdict.allHeaderTotalsPresent
          ? round2(headerVerdict.tolerance)
          : null,
        parser_path: parserPath,
        metadata: metadataJson,
      })
      .select("id")
      .single();
    if (error) {
      console.warn("[bill-parser-decisions] insert failed (non-fatal):", error);
    } else if (data?.id) {
      decisionId = data.id as string;
    }
  } catch (err) {
    console.warn("[bill-parser-decisions] insert threw (non-fatal):", err);
  }

  // PR4 (S142) — Slack notify on fire verdicts only (sign_violation, header_*,
  // multi). Non-fatal; failures swallowed inside notifyBillParserViolation.
  // Per-line-sparse verdicts NOT notified — that's today's PROD baseline per
  // S139 finding (firing would drown the channel until B-1 tool-use lands).
  if (decisionId && shouldNotify(verdict)) {
    const perLineFailingFields = perLineVerdicts
      .filter((v) => v.populated && !v.withinTolerance)
      .map((v) => v.field);
    const totalBilledRaw = metadata?.total_billed;
    const billTypeRaw = metadata?.bill_type;
    void notifyBillParserViolation({
      decisionId,
      verdict,
      parserPath,
      documentId: documentId ?? null,
      claimId: claimId ?? null,
      userId: userId ?? null,
      signViolationFields,
      headerReconciliationDelta:
        headerVerdict.allHeaderTotalsPresent && Number.isFinite(headerVerdict.delta)
          ? round2(headerVerdict.delta)
          : null,
      headerReconciliationTolerance: headerVerdict.allHeaderTotalsPresent
        ? round2(headerVerdict.tolerance)
        : null,
      perLineFailingFields,
      totalBilled: typeof totalBilledRaw === "number" ? totalBilledRaw : null,
      billType:
        billTypeRaw === "eob" || billTypeRaw === "itemized_bill"
          ? (billTypeRaw as "eob" | "itemized_bill")
          : null,
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Best-effort JSONB size cap. Serializes once; if oversize, drops free-form
 * fields except verdict_categories + sign_violations (load-bearing for admin
 * triage). Caller's metadata may be truncated; persist still records the
 * row.
 */
function bounded(payload: Record<string, unknown>, capBytes: number): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length <= capBytes) return payload;
    // Keep load-bearing fields only.
    return {
      verdict_categories: payload.verdict_categories ?? [],
      sign_violations: payload.sign_violations ?? [],
      _truncated_at_bytes: capBytes,
    };
  } catch {
    return { _truncation_error: true };
  }
}
