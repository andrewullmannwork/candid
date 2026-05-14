/**
 * S74.6 D3 — Audit feedback loop: cohort accuracy lookup + tiered confidence adjustment.
 *
 * Closes the write-only loop on `audit_rule_accuracy` (T2.2 Session 62). Audit findings
 * now consult cross-user win-rate at generation time. Three tiers:
 *
 *   - **Boost** (win_rate ≥ 0.5 AND n ≥ 5)
 *     `confidence_adjusted = clamp(baseline + (win_rate - 0.5) * 0.30, 0.50, 0.95)`
 *     Max swing +0.15. Caps individual finding confidence below "certainty" claims.
 *
 *   - **Informational chip** (0.2 ≤ win_rate < 0.5 AND n ≥ 10)
 *     Finding surfaces with a "lower success rate — still worth disputing" message
 *     attached. Confidence stays at baseline. UI renders the chip alongside the
 *     amber finding card so users have honest signal but aren't discouraged from
 *     disputing.
 *
 *   - **Suppressed** (win_rate < 0.2 AND n ≥ 10)
 *     Finding is dropped from the audit report entirely. Aggregate evidence says
 *     "this rule type rarely wins against this insurer for this service" so the
 *     friction of a false-positive amber card outweighs the value.
 *
 *   - **Baseline** (n < 10 OR empty cohort)
 *     Finding emits as-is. Below-threshold cohorts surface every finding so the
 *     flywheel can collect early-stage signal (prevents "suppress → no disputes →
 *     win_rate stays 0%" feedback trap; Subplan §5 #4).
 *
 * Pattern 1 #13 inheritance: quarantined outcomes already excluded from
 * `audit_rule_accuracy` (accuracy.ts:55-58 — `flywheel_eligibility_status='quarantined_outlier'`
 * skipped at upsert). D3 inherits the clean cohort automatically.
 *
 * Performance: batch-read upfront in `runAudit()` start. One query covers all
 * (rule, insurer, slug) combos the bill might trigger. <50ms typical.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditFinding, FindingType } from "../billing/types";

export interface CohortStats {
  winCount: number;
  lossCount: number;
  settledCount: number;
  totalDisputes: number;
  avgRecoveredPct: number | null;
}

/**
 * Composite key joining (rule_type, insurer_name). v1 aggregates across slugs
 * because service_slug isn't yet resolved at runAudit time (slug-mapping runs
 * post-audit during persist). Phase 2 can refine to (rule, insurer, slug) once
 * service-mapper moves upstream of audit.
 */
export type AccuracyMapKey = string;

export type AccuracyCohortMap = Map<AccuracyMapKey, CohortStats>;

/**
 * Determines what the audit pipeline should do with a finding given the cohort
 * stats. `boost` returns an adjusted confidence; `informational` returns the
 * finding unchanged plus a chip string to surface in the UI; `suppress` drops
 * the finding entirely; `baseline` emits as-is.
 */
export type AccuracyDecision =
  | { tier: "boost"; adjustedConfidence: number }
  | { tier: "informational"; chip: string }
  | { tier: "suppress" }
  | { tier: "baseline" };

const INFORMATIONAL_CHIP_TEXT =
  "Lower success rate in similar disputes — still worth pursuing if you believe the charge is wrong.";

/** Subplan §B locked math. */
const BOOST_RATE_FLOOR = 0.5;
const BOOST_N_FLOOR = 5;
const INFORMATIONAL_RATE_FLOOR = 0.2;
const INFORMATIONAL_N_FLOOR = 10;
const SUPPRESS_RATE_CEILING = 0.2;
const SUPPRESS_N_FLOOR = 10;
const CONFIDENCE_FLOOR = 0.5;
const CONFIDENCE_CEILING = 0.95;
const BOOST_MULTIPLIER = 0.3;

export function mapKey(
  ruleType: FindingType,
  insurerName: string,
): AccuracyMapKey {
  return `${ruleType}||${insurerName}`;
}

/**
 * Batch-load cohort stats for all (rule_type, insurer_name, service_slug) tuples
 * the audit pipeline might consult for this bill. Empty input → empty map.
 *
 * Reads `audit_rule_accuracy` rows. `insurer_canonical_id` is preferred when
 * available (Pattern 2 canonical FK) but the table uses `insurer_name` as the
 * unique-key today (T2.2 v3 dual-write — `insurer_canonical_id` is supplemental).
 * Caller passes `insurer_name` here for simplicity; future Phase 2 can swap to
 * the canonical_id path when migration completes (CF-16b OPS Sprint).
 */
export async function loadAccuracyCohortMap(
  supabase: SupabaseClient,
  tuples: Array<{
    ruleType: FindingType;
    insurerName: string;
  }>,
): Promise<AccuracyCohortMap> {
  const out: AccuracyCohortMap = new Map();
  if (tuples.length === 0) return out;

  // Dedup tuples — bills frequently have multiple lines, same rule fires more
  // than once, but the cohort key (rule, insurer) collapses repeats.
  const seen = new Set<AccuracyMapKey>();
  const distinctRuleTypes = new Set<FindingType>();
  const distinctInsurers = new Set<string>();
  for (const t of tuples) {
    const k = mapKey(t.ruleType, t.insurerName);
    if (seen.has(k)) continue;
    seen.add(k);
    distinctRuleTypes.add(t.ruleType);
    distinctInsurers.add(t.insurerName);
  }

  // Coarse OR-style fetch — Supabase doesn't natively support tuple IN, so we
  // pull the cross-product candidate rows and aggregate across slugs client-side.
  // Per-bill volumes are tiny (<10 distinct rule × insurer combos).
  const { data, error } = await supabase
    .from("audit_rule_accuracy")
    .select(
      "rule_type, insurer_name, service_slug, won_count, settled_count, lost_count, total_disputes, avg_recovered_pct",
    )
    .in("rule_type", Array.from(distinctRuleTypes))
    .in("insurer_name", Array.from(distinctInsurers));

  if (error) {
    console.warn("[accuracy-cohort-loader] load failed", error);
    return out;
  }

  // Aggregate per (rule, insurer) across all slug rows.
  for (const row of data ?? []) {
    const key = mapKey(
      row.rule_type as FindingType,
      (row.insurer_name as string) ?? "",
    );
    if (!seen.has(key)) continue;
    const prior = out.get(key);
    const won = Number(row.won_count ?? 0);
    const lost = Number(row.lost_count ?? 0);
    const settled = Number(row.settled_count ?? 0);
    const total = Number(row.total_disputes ?? 0);
    const rowAvg =
      row.avg_recovered_pct == null ? null : Number(row.avg_recovered_pct);
    if (!prior) {
      out.set(key, {
        winCount: won,
        lossCount: lost,
        settledCount: settled,
        totalDisputes: total,
        avgRecoveredPct: rowAvg,
      });
      continue;
    }
    // Weighted average of avg_recovered_pct by win+settled cohort sizes.
    const priorWinCohort = prior.winCount + prior.settledCount;
    const rowWinCohort = won + settled;
    const newWinCohort = priorWinCohort + rowWinCohort;
    let newAvg = prior.avgRecoveredPct;
    if (rowWinCohort > 0 && rowAvg !== null && newWinCohort > 0) {
      const priorComponent = (prior.avgRecoveredPct ?? 0) * priorWinCohort;
      const rowComponent = rowAvg * rowWinCohort;
      newAvg =
        Math.round(((priorComponent + rowComponent) / newWinCohort) * 100) /
        100;
    }
    out.set(key, {
      winCount: prior.winCount + won,
      lossCount: prior.lossCount + lost,
      settledCount: prior.settledCount + settled,
      totalDisputes: prior.totalDisputes + total,
      avgRecoveredPct: newAvg,
    });
  }

  return out;
}

/**
 * Tier decision per Subplan §B locked math. n = total_disputes (won + settled +
 * lost). win_rate counts wins AND settled (settled = partial recovery, treated
 * as a "win" for the user's purposes — they got money back).
 *
 * Pure function — testable with seeded cohorts.
 */
export function decideAccuracyAdjustment(
  baselineConfidence: number,
  cohort: CohortStats | undefined,
): AccuracyDecision {
  if (!cohort || cohort.totalDisputes < BOOST_N_FLOOR) {
    return { tier: "baseline" };
  }
  const winRate =
    (cohort.winCount + cohort.settledCount) / cohort.totalDisputes;

  // Boost tier (>= 0.5 win rate, n >= 5)
  if (
    winRate >= BOOST_RATE_FLOOR &&
    cohort.totalDisputes >= BOOST_N_FLOOR
  ) {
    const swing = (winRate - BOOST_RATE_FLOOR) * BOOST_MULTIPLIER;
    const raw = baselineConfidence + swing;
    const adjusted = Math.min(
      CONFIDENCE_CEILING,
      Math.max(CONFIDENCE_FLOOR, raw),
    );
    return { tier: "boost", adjustedConfidence: adjusted };
  }

  // Suppress tier (< 0.2 win rate, n >= 10)
  if (
    winRate < SUPPRESS_RATE_CEILING &&
    cohort.totalDisputes >= SUPPRESS_N_FLOOR
  ) {
    return { tier: "suppress" };
  }

  // Informational tier (0.2 <= win rate < 0.5, n >= 10)
  if (
    winRate >= INFORMATIONAL_RATE_FLOOR &&
    winRate < BOOST_RATE_FLOOR &&
    cohort.totalDisputes >= INFORMATIONAL_N_FLOOR
  ) {
    return { tier: "informational", chip: INFORMATIONAL_CHIP_TEXT };
  }

  // n falls between 5 (boost floor) and 10 (informational/suppress floor) →
  // baseline surfacing. Prevents "first 3 wins boost / first 3 losses suppress"
  // pendulum on small cohorts.
  return { tier: "baseline" };
}

/**
 * Apply the accuracy decision to a finding. Returns either an updated finding
 * (with possibly-bumped confidence + informational chip) or null when the
 * decision is to suppress.
 *
 * Caller (runAudit) filters out null returns before assembling the final report.
 */
export function applyAccuracyAdjustment(
  finding: AuditFinding,
  decision: AccuracyDecision,
): AuditFinding | null {
  if (decision.tier === "suppress") return null;
  if (decision.tier === "baseline") return finding;
  if (decision.tier === "boost") {
    return { ...finding, confidence: decision.adjustedConfidence };
  }
  // Informational: keep confidence, attach chip via cohortAccuracyChip field.
  return { ...finding, cohortAccuracyChip: decision.chip };
}
