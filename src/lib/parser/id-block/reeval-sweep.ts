/**
 * ID-Block PR3c — daily re-eval sweep ("delayed, not denied").
 *
 * The build-ahead release path for active-hold. When the gate runs in ACTIVE mode and
 * flags a FIRST promotion, it WITHHOLDS the doc-type promotion and records a 'held'
 * canonical_promotion_quarantine row. This sweep (a daily Vercel cron) revisits every
 * held row and asks the gate again: does the cluster look legitimate NOW? Thin-but-real
 * users keep engaging (claims, cards, age), so a cluster that was below the legitimacy
 * bar can cross it — and then the promotion is RELEASED automatically. No admin approval
 * is required; the admin Confirm/Clear/Hold actions (PR3b) remain an OPTIONAL early push.
 *
 * NON-NEGOTIABLES (SoT §3.5/§9.4):
 *   - Re-eval RE-RUNS THE GATE (gatherAndScoreCluster) — releases ONLY if legitimacy now
 *     clears, never an unconditional promote.
 *   - A release routes through the REAL CF-40 promote mechanism (applyAdminConfirmedPromotion
 *     → upsertDoctypePromotionState), NEVER a direct canonical write (Rule #4/#10).
 *   - Layer-4 (re_baseline / verification) DEFERS; a tuple that drifted off the held value
 *     is NOT promoted (the apply's expectedTupleKey guard); cluster gone → stays held.
 *   - Delayed-NOT-denied: a still-suspicious held row just stays held + reschedules. It is
 *     re-checked indefinitely (no give-up); the user's own data is never touched (Pattern 1 #13).
 *   - Per-row isolated (one bad row never aborts the sweep); idempotent; non-fatal.
 *
 * INERT until active-hold: in shadow mode the gate writes state='shadow', never 'held'
 * (decideQuarantineAction), so there are 0 held rows and this sweep is a no-op. It exists
 * so the release path is live the moment active mode starts withholding.
 *
 * Shape: a PURE decision (decideReEvalAction, fixture-locked — Ship Gate G4) wrapped by
 * the IO orchestrator (runReEvalSweep). The cron route is thin auth glue over runReEvalSweep.
 *
 * SoT: plans/id-block-corroboration-source-independence.md §3.5 + §9.4.
 */

import type { createServerClient } from "@/lib/supabase/server";
import { ID_BLOCK_FLAG_KEY, parseIdBlockConfig, type IdBlockConfig } from "./config";
import { gatherAndScoreCluster, type IdBlockGateArgs } from "./gate";
import {
  applyAdminConfirmedPromotion,
  type ApplyConfirmedPromotionResult,
} from "@/lib/parser/cf40-v4/apply-confirmed-promotion";
import { decideReEvalAction } from "./reeval-decision";
import { notifyIdBlockRelease } from "./slack";

type SupabaseClient = ReturnType<typeof createServerClient>;

// ── IO orchestrator ───────────────────────────────────────────────────────────

export interface ReEvalSweepSummary {
  ran: boolean;
  /** false → flag disabled, sweep skipped (gate system is off). */
  flagEnabled: boolean;
  mode: "shadow" | "active" | null;
  /** total held rows due this sweep (incl. any beyond the cap). */
  dueTotal: number;
  /** rows actually processed (≤ maxRowsPerSweep). */
  scanned: number;
  /** more rows were due than the per-sweep cap; the overflow rides the next sweep. */
  capped: boolean;
  released: number;
  stillFlagged: number;
  clusterGone: number;
  deferredLayer4: number;
  tupleDrifted: number;
  criteriaNotMet: number;
  writeFailed: number;
  /** lost a state-guarded write race (admin disposed concurrently). */
  raced: number;
  /** per-row exception (isolated; sweep continued). */
  errored: number;
}

type Row = Record<string, unknown>;

/**
 * Run one re-eval sweep. Reads the flag (disabled → skip), scans due held rows
 * (next_eval_at NULL or ≤ now, oldest first, capped), re-runs the gate on each, releases
 * the ones whose legitimacy cleared via the real promote mechanism, and reschedules the
 * rest. Service-role client (bypasses RLS — the table is service-role only). Non-fatal.
 */
export async function runReEvalSweep(
  supabase: SupabaseClient,
  nowIso: string = new Date().toISOString(),
): Promise<ReEvalSweepSummary> {
  const empty = (flagEnabled: boolean, mode: "shadow" | "active" | null): ReEvalSweepSummary => ({
    ran: flagEnabled,
    flagEnabled,
    mode,
    dueTotal: 0,
    scanned: 0,
    capped: false,
    released: 0,
    stillFlagged: 0,
    clusterGone: 0,
    deferredLayer4: 0,
    tupleDrifted: 0,
    criteriaNotMet: 0,
    writeFailed: 0,
    raced: 0,
    errored: 0,
  });

  // Flag read (enabled gates the sweep; config carries thresholds + cadence). Read
  // failure or flag OFF → no-op (the cron is part of the gate system; OFF = inert).
  let cfg: IdBlockConfig;
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("enabled, config")
      .eq("flag_key", ID_BLOCK_FLAG_KEY)
      .maybeSingle();
    if ((data as { enabled?: boolean } | null)?.enabled !== true) return empty(false, null);
    cfg = parseIdBlockConfig((data as { config?: unknown }).config ?? null);
  } catch {
    return empty(false, null);
  }

  const summary = empty(true, cfg.gate.mode);
  const cap = cfg.reEval.maxRowsPerSweep;
  const dueFilter = `next_eval_at.is.null,next_eval_at.lte.${nowIso}`;

  // Scan: held AND (next_eval_at IS NULL OR ≤ now). An exact count first (cheap, indexed
  // on state+next_eval_at) makes dueTotal HONEST even when the batch is capped — the
  // capped overflow is visible (no silent truncation), not under-reported as cap+1.
  const { count: dueCount } = await supabase
    .from("canonical_promotion_quarantine")
    .select("id", { count: "exact", head: true })
    .eq("state", "held")
    .or(dueFilter);
  summary.dueTotal = dueCount ?? 0;
  summary.capped = summary.dueTotal > cap;

  // Fetch the batch — NULLS FIRST so freshly-held rows (live gate writes next_eval_at=null)
  // are processed first, not starved behind older rescheduled ones.
  const { data: rowsData, error } = await supabase
    .from("canonical_promotion_quarantine")
    .select("*")
    .eq("state", "held")
    .or(dueFilter)
    .order("next_eval_at", { ascending: true, nullsFirst: true })
    .limit(cap);
  if (error) {
    console.error("[id-block-reeval] scan failed:", error.message);
    return summary;
  }
  const batch = (rowsData ?? []) as Row[];
  if (summary.capped) {
    console.warn(
      `[id-block-reeval] ${summary.dueTotal} held rows due; processing ${cap} (maxRowsPerSweep). ` +
        `The ${summary.dueTotal - cap} overflow ride the next sweep.`,
    );
  }

  const nextEvalAt = new Date(
    new Date(nowIso).getTime() + cfg.reEval.cadenceDays * 86_400_000,
  ).toISOString();

  for (const row of batch) {
    summary.scanned += 1;
    try {
      await processRow(supabase, row, cfg, nowIso, nextEvalAt, summary);
    } catch (err) {
      summary.errored += 1;
      console.error(
        `[id-block-reeval] row ${String(row.id)} threw (isolated, non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(
    `[id-block-reeval] sweep done: mode=${summary.mode} due=${summary.dueTotal} scanned=${summary.scanned}` +
      ` released=${summary.released} stillFlagged=${summary.stillFlagged} clusterGone=${summary.clusterGone}` +
      ` deferredL4=${summary.deferredLayer4} tupleDrifted=${summary.tupleDrifted}` +
      ` criteriaNotMet=${summary.criteriaNotMet} writeFailed=${summary.writeFailed} raced=${summary.raced}` +
      ` errored=${summary.errored} capped=${summary.capped}`,
  );
  return summary;
}

/** Re-evaluate one held row and write its disposition. Throws to the per-row isolator. */
async function processRow(
  supabase: SupabaseClient,
  row: Row,
  cfg: IdBlockConfig,
  nowIso: string,
  nextEvalAt: string,
  summary: ReEvalSweepSummary,
): Promise<void> {
  const id = row.id as string;
  const canonicalPlanId = row.canonical_plan_id as string;
  const documentType = row.document_type as string;
  const valueTupleKey = row.value_tuple_key as string;

  const args: IdBlockGateArgs = {
    canonicalPlanId,
    docType: documentType,
    // The 4 cost scalars stored at hold time; the gate re-derives the CURRENT cluster
    // for this tuple. scaleTier is display-only here (it does not feed wouldFlag).
    baselineTuple: (row.value_tuple_jsonb ?? null) as Record<string, number | null> | null,
    scaleTier: (row.scale_tier as string | null) ?? "cold_start",
  };

  // ── 1. RE-RUN THE GATE (legitimacy), NOT the admin bypass ──
  const outcome = await gatherAndScoreCluster(supabase, args, cfg);
  const clusterGone = outcome === null;
  const wouldFlag = outcome?.result.wouldFlag ?? false;

  // ── 2. If the gate cleared, attempt the REAL promote (gate bypass now justified) ──
  let apply: ApplyConfirmedPromotionResult | undefined;
  if (!clusterGone && !wouldFlag) {
    apply = await applyAdminConfirmedPromotion(supabase, canonicalPlanId, documentType, {
      expectedTupleKey: valueTupleKey,
    });
  }

  const action = decideReEvalAction({ clusterGone, wouldFlag, applyReason: apply?.reason });

  // ── 3. Write the disposition (state-guarded vs the live-gate refresh + admin actions) ──
  if (action.newState === "promoted") {
    const { data: updated, error } = await supabase
      .from("canonical_promotion_quarantine")
      .update({ state: "promoted", updated_at: nowIso })
      .eq("id", id)
      .eq("state", "held")
      .select("id")
      .maybeSingle();
    if (error) {
      console.error(`[id-block-reeval] release write failed for ${id}:`, error.message);
      return;
    }
    if (!updated) {
      // Lost the race — an admin disposed it first. The promotion is already applied
      // (sticky, harmless); the admin's row disposition wins.
      summary.raced += 1;
      return;
    }
    summary.released += 1;
    if (cfg.slack.enabled && outcome) {
      void notifyIdBlockRelease({
        quarantineId: id,
        canonicalPlanId,
        documentType,
        clusterScore: outcome.result.clusterScore,
        clusterSize: outcome.clusterUserIds.length,
        scaleTier: args.scaleTier,
        reason: action.machineReason,
        observed: apply?.observed,
      });
    }
    return;
  }

  // Stay held — tally + reschedule (state-guarded; a disposed row is skipped).
  tallyStayHeld(action.machineReason, summary);
  if (action.writeFailed) {
    console.error(
      `[id-block-reeval] release verify-the-write failed for ${id} (canonical=${canonicalPlanId}); left held.`,
    );
  }
  if (action.reschedule) {
    const { error } = await supabase
      .from("canonical_promotion_quarantine")
      .update({ next_eval_at: nextEvalAt, updated_at: nowIso })
      .eq("id", id)
      .eq("state", "held");
    if (error) {
      console.error(`[id-block-reeval] reschedule write failed for ${id}:`, error.message);
    }
  }
}

function tallyStayHeld(machineReason: string, summary: ReEvalSweepSummary): void {
  switch (machineReason) {
    case "still_flagged":
      summary.stillFlagged += 1;
      break;
    case "cluster_gone":
      summary.clusterGone += 1;
      break;
    case "deferred_layer4":
      summary.deferredLayer4 += 1;
      break;
    case "tuple_drifted":
      summary.tupleDrifted += 1;
      break;
    case "write_failed":
      summary.writeFailed += 1;
      break;
    default:
      // criteria_not_met / no_inputs / invalid_doc_type / missing_apply_reason
      summary.criteriaNotMet += 1;
  }
}
