/**
 * ID-Block PR3b — apply an admin-CONFIRMED (or cleared-as-benign) HELD doc-type
 * promotion via the EXACT CF-40 Layer-3 promote mechanism.
 *
 * When the ID-Block gate runs in ACTIVE mode and flags a FIRST promotion, it
 * WITHHOLDS the doc-type promotion (record-parse-event.ts forces promoted=false →
 * canonical_doctype_promotion_state.doctype_promoted stays false) and records a
 * 'held' canonical_promotion_quarantine row. An admin who reviews the §4 inventory
 * and decides the cluster is legitimate (Confirm) — or that the flag was benign
 * (Clear) — RELEASES that promotion. The release works by RE-DERIVING the Layer-3
 * decision from the CURRENT flywheel state (gatherLayer3Inputs → decideDoctypePromotion)
 * with the ID-Block gate INTENTIONALLY BYPASSED (the admin is the override authority —
 * S175 Decision 1), then writing it through the same upsertDoctypePromotionState the
 * live recorder uses. NEVER a direct canonical write (Rule #4/#10); never fabricates a
 * promotion (if the canonical no longer meets Layer-3, it records that + applies nothing).
 *
 * Layer-4 precedence (the recorder's "one adjudication at a time" discipline,
 * record-parse-event.ts §Layer-3(b)): if the canonical/doc_type is mid re-baseline
 * (re_baseline_required) or has an open verification (divergencePendingVerification),
 * the release DEFERS — the Layer-4 state machine owns the canonical; the admin resolves
 * it on /admin/canonical-quality first.
 *
 * SoT: plans/id-block-corroboration-source-independence.md §3.4/§4.3 + §9.3.
 */

import type { createServerClient } from "@/lib/supabase/server";
import { ADMIN_ATTESTATION_FLAG_KEY } from "./index";
import { loadCF40V4Config } from "./config";
import { decideDoctypePromotion, gatherLayer3Inputs, identityKey } from "./doctype-promotion-aggregator";
import { upsertDoctypePromotionState } from "./record-parse-event";
import { toPlanDocType } from "@/lib/parser/doctype-expected-counts";
import { isFeatureEnabled } from "@/lib/config/product-flags";

type SupabaseClient = ReturnType<typeof createServerClient>;

export type ApplyPromotionReason =
  | "promoted" //          re-derived + applied via the CF-40 mechanism (and verified)
  | "invalid_doc_type" //  document_type is not a plan-doc type
  | "deferred_layer4" //   re-baseline / verification in progress — Layer-4 owns it
  | "no_inputs" //         no user-side uploads to evaluate (cluster gone)
  | "criteria_not_met" //  Layer-3 no longer promotes (e.g. cluster shrank) — nothing forced
  | "tuple_drifted" //     current supermajority winner ≠ the gated/expected tuple — refuse
  | "write_failed"; //     upsert did not land (verify read came back not-promoted)

export interface ApplyConfirmedPromotionResult {
  applied: boolean;
  reason: ApplyPromotionReason;
  /** the promotion event type when applied (organic / admin-attested). */
  eventType?: "pattern1_3_organic" | "admin_attested";
  /** observed Layer-3 criteria at apply time (for the admin response + audit). */
  observed?: { distinctUsers: number; totalUploads: number; coverageScore: number };
}

/**
 * Re-apply a withheld doc-type promotion on admin confirm/clear OR on a re-eval-cron
 * release. Bypasses the ID-Block gate (the admin is the override authority; the cron
 * has already re-run the gate and it cleared — S175/S176) and routes through the real
 * promote writer, then VERIFIES the write landed so the caller can fail loud (G2 —
 * leave the row 'held' if the apply didn't take). Returns a structured outcome; it
 * does not throw for the "didn't promote" cases (those are legitimate verdicts to record).
 *
 * `opts.expectedTupleKey` (S176 tuple-drift guard): when provided, the apply promotes
 * ONLY if the CURRENT supermajority winner's key equals it — i.e. the value about to be
 * promoted is the SAME value that was gated/held. Decouples "what we gated" from "what we
 * promote": a (canonical, doc_type) promotes whatever the live supermajority is, so a
 * consensus that drifted T→T′ while a row sat held would otherwise launder an un-gated T′
 * past the gate. On mismatch → reason 'tuple_drifted' (promote nothing). Omit it for the
 * legacy unconditional behavior.
 */
export async function applyAdminConfirmedPromotion(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: string,
  opts: { expectedTupleKey?: string } = {},
): Promise<ApplyConfirmedPromotionResult> {
  const planDocType = toPlanDocType(docType);
  if (!planDocType) return { applied: false, reason: "invalid_doc_type" };

  // Layer-4 precedence: never force a promotion while a re-baseline is mid-adjudication
  // (the recorder follows the same discipline). Admin resolves that on
  // /admin/canonical-quality first, then re-confirms.
  const pre = await readPromotionState(supabase, canonicalPlanId, planDocType);
  if (pre.reBaselineRequired) return { applied: false, reason: "deferred_layer4" };

  const cfg = await loadCF40V4Config(supabase);
  const inputs = await gatherLayer3Inputs(supabase, canonicalPlanId, planDocType, new Date(), cfg);
  if (!inputs) return { applied: false, reason: "no_inputs" };
  if (inputs.divergencePendingVerification) return { applied: false, reason: "deferred_layer4" };

  // Mirror the recorder's admin-attested gate (admin_attestation_enabled is ON/global
  // in PROD); there is no uploader email at admin-action time → resolve globally.
  let adminEnabled = false;
  try {
    adminEnabled = await isFeatureEnabled(ADMIN_ATTESTATION_FLAG_KEY);
  } catch {
    adminEnabled = false;
  }

  const { result, eventType } = decideDoctypePromotion(inputs, planDocType, adminEnabled, cfg);
  const observed = {
    distinctUsers: result.observed.distinctUsers,
    totalUploads: result.observed.totalUploads,
    coverageScore: result.observed.coverageScore,
  };
  if (!result.promoted) return { applied: false, reason: "criteria_not_met", observed };

  // Tuple-drift guard (S176): only promote if the live supermajority winner is the SAME
  // value the caller gated/held. result.promoted ⇒ baselineTuple is non-null. If the
  // consensus drifted away from expectedTupleKey, refuse — the new winner has its own
  // gate evaluation (its own live-gate quarantine row); we never promote an un-gated value.
  if (opts.expectedTupleKey !== undefined) {
    const currentKey = inputs.baselineTuple ? identityKey(inputs.baselineTuple) : null;
    if (currentKey !== opts.expectedTupleKey) {
      return { applied: false, reason: "tuple_drifted", observed };
    }
  }

  // Route through the EXACT promote writer the recorder uses (sticky upsert).
  // clearReBaseline=false: we already deferred when re_baseline_required was set.
  await upsertDoctypePromotionState(supabase, canonicalPlanId, planDocType, result, eventType, false);

  // Verify the write landed — upsertDoctypePromotionState returns void and does not
  // surface a supabase error, so confirm by reading back. result.promoted is true here,
  // so a successful upsert MUST leave doctype_promoted=true (sticky never demotes).
  const post = await readPromotionState(supabase, canonicalPlanId, planDocType);
  if (!post.doctypePromoted) return { applied: false, reason: "write_failed", observed };
  return { applied: true, reason: "promoted", eventType, observed };
}

/** One read of the (canonical, doc_type) promotion state — both gate-relevant flags. */
async function readPromotionState(
  supabase: SupabaseClient,
  canonicalPlanId: string,
  docType: string,
): Promise<{ doctypePromoted: boolean; reBaselineRequired: boolean }> {
  try {
    const { data } = await supabase
      .from("canonical_doctype_promotion_state")
      .select("doctype_promoted, re_baseline_required")
      .eq("canonical_plan_id", canonicalPlanId)
      .eq("document_type", docType)
      .maybeSingle();
    const row = data as { doctype_promoted?: boolean; re_baseline_required?: boolean } | null;
    return {
      doctypePromoted: row?.doctype_promoted === true,
      reBaselineRequired: row?.re_baseline_required === true,
    };
  } catch {
    return { doctypePromoted: false, reBaselineRequired: false };
  }
}
