/**
 * ID-Block PR3c — pure re-eval disposition (fixture-locked, Ship Gate G4).
 *
 * Split from reeval-sweep.ts (IO) so the load-bearing matrix is testable without the
 * DB / CF-40 promote import chain — mirrors cluster-action.ts (pure) vs the admin route
 * (IO). Maps a re-eval outcome to the held-row disposition.
 *
 * The ONLY transition to 'promoted' is (gate cleared AND the real promote mechanism
 * applied it for the SAME tuple). Every other branch stays held + reschedules — never
 * auto-rejects (delayed-not-denied, Pattern 1 #13).
 *
 * SoT: plans/id-block-corroboration-source-independence.md §3.5.
 */

import type { ApplyPromotionReason } from "@/lib/parser/cf40-v4/apply-confirmed-promotion";

export interface ReEvalActionInput {
  /** gatherAndScoreCluster returned null — no verified same-tuple cluster of ≥2 (cluster gone/shrank). */
  clusterGone: boolean;
  /** the gate re-run's wouldFlag (meaningful only when !clusterGone). */
  wouldFlag: boolean;
  /**
   * the real-promote-mechanism reason. The IO MUST call applyAdminConfirmedPromotion
   * exactly when (!clusterGone && !wouldFlag) — i.e. the gate cleared — so applyReason is
   * present in that case and undefined otherwise.
   */
  applyReason?: ApplyPromotionReason;
}

export interface ReEvalAction {
  /** the state to write to the quarantine row. */
  newState: "held" | "promoted";
  /** re-stamp next_eval_at = now + cadenceDays so the row is re-checked later (stay-held only). */
  reschedule: boolean;
  /** fire the Slack auto-release notification (true releases only). */
  slackRelease: boolean;
  /** machine reason for logs/Slack (NOT a DB column — admin_decision stays NULL on a cron release). */
  machineReason: string;
  /** the apply verify-the-write failed (G2): log loud, leave held. */
  writeFailed: boolean;
}

/**
 * Map a re-eval outcome to the row disposition. Pure. Never auto-rejects: every non-release
 * branch stays held and reschedules so a thin-but-real cluster keeps being re-checked.
 */
export function decideReEvalAction(input: ReEvalActionInput): ReEvalAction {
  const stayHeld = (machineReason: string, writeFailed = false): ReEvalAction => ({
    newState: "held",
    reschedule: true,
    slackRelease: false,
    machineReason,
    writeFailed,
  });

  if (input.clusterGone) return stayHeld("cluster_gone");
  if (input.wouldFlag) return stayHeld("still_flagged");

  // Gate cleared → the IO attempted the real promote. Branch on its verdict.
  switch (input.applyReason) {
    case "promoted":
      return {
        newState: "promoted",
        reschedule: false,
        slackRelease: true,
        machineReason: "re_eval_cleared",
        writeFailed: false,
      };
    case "write_failed":
      return stayHeld("write_failed", true);
    case "deferred_layer4":
      return stayHeld("deferred_layer4");
    case "tuple_drifted":
      return stayHeld("tuple_drifted");
    case "criteria_not_met":
      return stayHeld("criteria_not_met");
    case "no_inputs":
      return stayHeld("no_inputs");
    case "invalid_doc_type":
      return stayHeld("invalid_doc_type");
    case undefined:
      // Defensive: IO contract says applyReason is present when the gate cleared. If it
      // is missing, treat as a no-op stay-held (never release without a real apply).
      return stayHeld("missing_apply_reason");
    default:
      return stayHeld(input.applyReason);
  }
}
