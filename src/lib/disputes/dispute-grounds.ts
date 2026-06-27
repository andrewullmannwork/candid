/**
 * §18 — the DisputeGround model + per-line ground derivation + the deductible-aware letter
 * recovery (the runtime side of the unified grounds taxonomy).
 *
 * A `DisputeGround` is ONE structured argument the dispute letter makes. The model
 * WRAPS `LineItemEvidence` (the resolver's rich per-line output) rather than flattening
 * it, so it inherits the plan-benefit citation, the expected/actual/discrepancy math,
 * `patientPaid`, the corroboration signals, and the attestation flag for free.
 *
 * The per-ground TAXONOMY METADATA (render order, scorer class, request bucket, source
 * findings, recovery scope) is the single source of truth in [[dispute-ground-catalog]]
 * (`DISPUTE_GROUND_CATALOG`). This file holds the `DisputeGroundType` union + the runtime
 * `groundsForLine` / `resolveLetterRecovery` (live behind `dispute_grounds_v1`) +
 * `computeCappedRecovery`. Each ground maps to a scorer `DisputeTypeClass` via the catalog's
 * `scoringClass` (the two taxonomies are NOT identical — `duplicate`/`unbundling`/
 * `unallocated_balance` have no class of their own; `coverage_corroboration`/`other` have no ground).
 *
 * R3 step 1 REMOVED the never-wired `buildDisputeGrounds` aggregator + its private
 * `TYPE_ORDER`/`TIER_RANK`/`strongerTier` (dead scaffolding — zero `src/` callers; it MISLED the
 * D3 design, §5.5). The LIVE letter path is `classifyDisputeType` → `li.disputeType` →
 * `buildRequestSection`; the recovery path is `groundsForLine` → `resolveLetterRecovery`
 * (flag-gated). The classifier collapse (`classifyDisputeType` ↔ `groundsForLine` reconcile) is a
 * separately-gated step AFTER this byte-identical seed. See [[unified_dispute_claim_engine_plan]] §2 R3.
 */
import type { CiteGradeTier } from "./strength-scoring";
import type { DisputeEvidence, LineItemEvidence } from "./evidence-resolver";
import type { CostShareV2Result, CostShareAssumption } from "../claims/recovery-math";

/**
 * The dispute-ground taxonomy keys. Per-ground metadata (render order, scorer class, request
 * bucket, source findings, recovery scope) is the single source of truth in
 * [[dispute-ground-catalog]] (`DISPUTE_GROUND_CATALOG`).
 */
export type DisputeGroundType =
  | "service_not_rendered" // attested not received → the whole charge is the pool
  | "balance_billing" // charged above the protected / allowed (contracted) rate
  | "duplicate" // same service billed twice
  | "unbundling" // a bundled service split to inflate
  | "coverage_contradiction" // a covered service the insurer didn't pay
  | "cost_share_misapplication" // wrong copay / coinsurance vs plan terms
  | "benchmark" // billed far above the CMS / community benchmark (overcharge)
  | "unallocated_balance" // bill header total exceeds the sum of line responsibilities
  | "coding_peer"; // a peer code is paid for the same service

/**
 * A render-ready finding for a ground: the persisted `description` (now surfaced via the
 * resolver, Gap 1) + the line's `billedAmount` (the finding-level billedAmount is NOT
 * persisted). This is exactly what `templates.ts:933` needs to reproduce the detail block.
 */
export interface GroundFinding {
  type: string;
  title: string;
  description: string | null;
  billedAmount: number; // from the line (LineItemEvidence.billedAmount)
  estimatedOvercharge: number;
  benchmarkAmount: number | null;
  benchmarkSource: string | null;
}

export interface DisputeGround {
  type: DisputeGroundType;
  claimId: string;
  lineItemIds: string[];
  lines: LineItemEvidence[]; // wrapped, not flattened
  findings: GroundFinding[];
  /** The ground's RAW recovery (sum of its lines' contributions). The de-overlapped,
   *  exposure-capped TOTAL that drives `amount_disputed` is `computeCappedRecovery`. */
  dollarAtStake: number;
  citeGradeTier: CiteGradeTier; // the ground's strongest spine
}

function findingDollar(line: LineItemEvidence, findingType: string): number {
  return (line.auditFindings ?? [])
    .filter((f) => f.type === findingType)
    .reduce((s, f) => s + Math.max(0, f.estimatedOvercharge), 0);
}

function buildGroundFindings(line: LineItemEvidence, findingType?: string): GroundFinding[] {
  return (line.auditFindings ?? [])
    .filter((f) => !findingType || f.type === findingType)
    .map((f) => ({
      type: f.type,
      title: f.title,
      description: f.description ?? null,
      billedAmount: line.billedAmount, // finding-level billedAmount is not persisted
      estimatedOvercharge: f.estimatedOvercharge,
      benchmarkAmount: f.benchmarkAmount,
      benchmarkSource: f.benchmarkSource,
    }));
}

/**
 * The grounds for ONE line: the primary spine + additive, NON-contradictory secondaries.
 * Compatibility (Refinement): balance_billing + cost_share = additive (different wrongs);
 * coverage_contradiction + cost_share = mutually exclusive; service_not_rendered is primary
 * (whole charge) and a cost-share argument may ride "in the alternative".
 */
export function groundsForLine(line: LineItemEvidence, claimId: string): DisputeGround[] {
  const out: DisputeGround[] = [];
  const findingTypes = new Set((line.auditFindings ?? []).map((f) => f.type));
  const mk = (type: DisputeGroundType, dollar: number, findingType?: string): DisputeGround => ({
    type,
    claimId,
    lineItemIds: [line.lineItemId],
    lines: [line],
    findings: buildGroundFindings(line, findingType),
    dollarAtStake: Math.max(0, Math.round(dollar * 100) / 100),
    citeGradeTier: line.citeGradeTier,
  });

  // service_not_rendered — PRIMARY when attested; the whole charge is the pool.
  if (line.serviceNotRenderedAttested) out.push(mk("service_not_rendered", line.billedAmount));

  // Audit-finding-derived detector grounds (Correction 2 keeps these explicit).
  if (findingTypes.has("balance_billing")) out.push(mk("balance_billing", findingDollar(line, "balance_billing"), "balance_billing"));
  if (findingTypes.has("duplicate")) out.push(mk("duplicate", findingDollar(line, "duplicate"), "duplicate"));
  if (findingTypes.has("unbundling")) out.push(mk("unbundling", findingDollar(line, "unbundling"), "unbundling"));
  if (findingTypes.has("overcharge")) out.push(mk("benchmark", findingDollar(line, "overcharge"), "overcharge"));
  if (findingTypes.has("unallocated_balance")) out.push(mk("unallocated_balance", findingDollar(line, "unallocated_balance"), "unallocated_balance"));

  // Cost-share vs coverage-contradiction — MUTUALLY EXCLUSIVE; additive over balance_billing.
  const zeroCs = findingTypes.has("zero_cost_share_overcharge");
  const coverageContra = findingTypes.has("insurance_underpayment") || findingTypes.has("missing_adjustment");
  const structuralCostShare = !!line.planBenefit && (line.discrepancyAmount ?? 0) > 0;
  if (zeroCs || structuralCostShare) {
    out.push(mk("cost_share_misapplication", line.discrepancyAmount ?? findingDollar(line, "zero_cost_share_overcharge")));
  } else if (coverageContra) {
    out.push(mk("coverage_contradiction", findingDollar(line, "insurance_underpayment") + findingDollar(line, "missing_adjustment")));
  } else if (line.planBenefit) {
    out.push(mk("coverage_contradiction", 0));
  }

  // coding_peer — supporting; only when ≥2 corroborated peers (the existing letterEligible gate).
  if (line.peerCodes && line.peerCodes.length >= 2) out.push(mk("coding_peer", 0));

  return out;
}

/**
 * §18 incr-3 — the render-ready findings for the 3 provider templates' (overcharge /
 * balance_billing / duplicate) detail block, sourced from the resolved EVIDENCE (which BOTH
 * generate AND rerender pass to template.body) rather than the AuditReport `findings` (nulled
 * on the rerender path → the $0.00 bug). Each line's auditFindings appear ONCE, with
 * `billedAmount` from the LINE (the finding-level billedAmount is not persisted). Per §18.9
 * Call A the letter argues EVERY ground on the disputed charges, so this returns all findings
 * on the dispute's (evidence-scoped) lines — not a finding-id subset (those ids regenerate on
 * each re-parse → never stable across a refresh; the root cause of the $0.00 bug). Empty when
 * evidence is null → callers fall back to the AuditReport findings (generate-path parity).
 *
 * Iterates LINES (not buildDisputeGrounds' grounds): a finding can ride multiple grounds
 * (e.g. a no-`findingType` coverage_contradiction ground carries the whole line) → flat-
 * mapping grounds would double-count. Per-line `buildGroundFindings` emits each finding once.
 */
export function groundFindingsForEvidence(evidence: DisputeEvidence | null): GroundFinding[] {
  if (!evidence) return [];
  const out: GroundFinding[] = [];
  for (const claim of evidence.claims) {
    for (const line of claim.lineItemEvidence) {
      out.push(...buildGroundFindings(line));
    }
  }
  return out;
}

/**
 * §18.5 / Call A — the per-line cap, SHARED by computeCappedRecovery (the total, number-map)
 * and resolveLetterRecovery (the per-line letter dollars, rich-map) so there is exactly ONE
 * cap implementation (the regression-sensitive crux — no drift). Caps the raw ground sum at
 * the patient's real wrongful loss = `max(patientPaid, patientOwes) − shouldOwe`. `shouldOwe`
 * is null only when no basis is supplied (flag OFF / Stages 1–3) → INERT, raw passes through.
 */
function capLineRaw(
  line: LineItemEvidence,
  rawSum: number,
  shouldOwe: number | null,
): { capped: number; capBound: boolean } {
  if (shouldOwe == null) return { capped: rawSum, capBound: false };
  const exposure = Math.max(line.patientPaid ?? 0, line.patientOwes ?? 0);
  const cap = Math.max(0, exposure - shouldOwe);
  const capped = Math.min(rawSum, cap);
  return { capped, capBound: capped < rawSum - 0.005 };
}

/**
 * §18.5 / Call A — the de-overlapped, exposure-capped TOTAL recovery. PER LINE: sum the line's
 * ground dollars, then CAP at `max(patientPaid, patientOwes) − shouldOwe`. `service_not_rendered`
 * resets `shouldOwe→0` (the whole charge is recoverable). `shouldOwe` is OPTIONAL — absent (Stages
 * 1–3) → the cap is INERT. The live letter dollars come from resolveLetterRecovery (which shares
 * capLineRaw).
 *
 * R3 step 1 (§5.5): currently NO `src/` caller — `amount_disputed` is driven by
 * `resolveLetterRecovery.total`, not this. RETAINED (not removed) pending the R3 step-5
 * multi-charge claim-total model, which will either build on this number-map path or supersede it.
 * Exercised by the builder fixture (C1–C4).
 */
export function computeCappedRecovery(
  evidence: DisputeEvidence | null,
  shouldOwePerLine?: Map<string, number | null>,
): { total: number; capBoundLineIds: string[] } {
  if (!evidence) return { total: 0, capBoundLineIds: [] };
  let total = 0;
  const capBoundLineIds: string[] = [];

  for (const claim of evidence.claims) {
    for (const line of claim.lineItemEvidence) {
      const grounds = groundsForLine(line, claim.claimId);
      if (grounds.length === 0) continue;
      const rawSum = grounds.reduce((s, g) => s + g.dollarAtStake, 0);
      const notRendered = grounds.some((g) => g.type === "service_not_rendered");
      const shouldOwe = notRendered ? 0 : shouldOwePerLine?.get(line.lineItemId) ?? null;
      const { capped, capBound } = capLineRaw(line, rawSum, shouldOwe);
      if (capBound) capBoundLineIds.push(line.lineItemId);
      total += capped;
    }
  }
  return { total: Math.round(total * 100) / 100, capBoundLineIds };
}

/**
 * §18.10.A/D + the OON-rate gate — whether the letter may ASSERT this line's precise
 * deductible-aware dollar, or must OMIT it (fall to the insurer-reprocess demand + prompt
 * the user to confirm). Assertable only when `shouldOwe` rests on KNOWN facts:
 *  • `shouldOweGrounded` — the engine's own honesty gate (hard met-status data, a known
 *    cost-share rate, or insurer-$0 pure-deductible proof). Covers deductible/OOP/rate incl.
 *    the OON-RATE-MISSING case (no OON rate → costShareUnknown → not grounded). §18.10.D.
 *  • no `network` assumption — an ASSUMED-in-network line could secretly be OON (in-network
 *    params understate shouldOwe → over-claim). The OON conservative gate, data-driven (clears
 *    when claim/flywheel supplies network — §18.10.F). NOT caught by shouldOweGrounded.
 *  • no `denial` / `aca_preventive` / `deductible_applies` — the three guesses the engine
 *    pushes that DON'T flip shouldOweGrounded yet still make the dollar a guess (the verdict
 *    downgrades them, but `verdict==="recovery"` fires first on a disputed line).
 * `deductible_met` / `oop_met` / `service_cost` are deliberately NOT excluded — shouldOweGrounded
 * already handles them, and excluding them would wrongly omit the legit insurer-$0 pure-deductible
 * recovery + the OOP-met conservative floor (which never over-claims).
 *
 * NOTE (§18.10.F next-session): "case B" (assert off the insurer's adjudicated cheapest rate
 * without a hard accumulator) lands by making MORE lines `shouldOweGrounded` in the engine — an
 * additive grounding source, NOT a change to this predicate. Until then case-B lines omit + prompt.
 */
const BLOCKING_ASSUMPTION_FIELDS: ReadonlySet<CostShareAssumption["field"]> = new Set([
  "network",
  "denial",
  "aca_preventive",
  "deductible_applies",
]);
export function isPreciseDollarAssertable(result: CostShareV2Result): boolean {
  return (
    result.shouldOweGrounded &&
    !result.assumptions.some((a) => BLOCKING_ASSUMPTION_FIELDS.has(a.field))
  );
}

/**
 * §18.10.D — assumption fields that block the precise dollar but the user CAN'T toggle away
 * (missing cost-share rate, an inferred deductible-applies, an insurer denial, an unknown ACA-
 * preventive status). When a non-assertable line carries one of these, confirming deductible /
 * OOP / network would NOT make it assertable → the strengthen prompt must NOT offer those fields
 * (it would over-promise a dollar it can't deliver — the cf91a49e rate-starved case). That gap is
 * the "add plan details" / cold-start lane, not this prompt. (network is NOT here — it IS
 * user-fixable; the user confirms in/out-of-network.)
 */
const PROMPT_BLOCKING_FIELDS: ReadonlySet<CostShareAssumption["field"]> = new Set([
  "service_cost",
  "deductible_applies",
  "denial",
  "aca_preventive",
]);

/** §18 incr-4 — the per-line deductible-aware letter dollars (one row per disputed line). */
export interface LineRecovery {
  lineItemId: string;
  /** deductible-aware correct share (0 for an attested not-rendered line). */
  shouldOwe: number;
  /** Call A: min(Σ grounds' dollarAtStake, max(patientPaid, patientOwes) − shouldOwe). */
  capped: number;
  /** refund portion of `capped` — patient already PAID above shouldOwe. */
  refund: number;
  /** write-off portion of `capped` — still BILLED above shouldOwe. */
  writeOff: number;
  /** §18.10.D — may the letter assert this precise dollar, or omit + prompt. */
  assertable: boolean;
}

/**
 * §18 incr-4 — resolve the per-line DEDUCTIBLE-AWARE letter dollars, keyed by lineItemId.
 * buildRequestSection sources the cost-share + balance-billing refund/write-off from here
 * (not the deductible-BLIND `discrepancyAmount`) so the letter dollar == the card recovery
 * (both from computeCostShareV2). `total` sums ASSERTABLE lines only (an omitted line must not
 * inflate `amount_disputed` — Call B); it bumps automatically on redraft once the user confirms.
 *
 * `basis` is loadDisputeGroundBasis's rich result map (keyed by claim_line_items.id =
 * LineItemEvidence.lineItemId). Only reached when dispute_grounds_v1 is ON; the OFF path never
 * calls this (buildRequestSection falls back to discrepancyAmount → byte-identical). A
 * service_not_rendered line is always assertable (attestation IS the basis; shouldOwe 0).
 */
export function resolveLetterRecovery(
  evidence: DisputeEvidence | null,
  basis: Map<string, CostShareV2Result>,
): {
  byLine: Map<string, LineRecovery>;
  total: number;
  capBoundLineIds: string[];
  /** §18.10.D — a precise dollar was OMITTED on ≥1 line because it rested on a guess. */
  weakened: boolean;
  /** the USER-FIXABLE inputs that, once confirmed, would strengthen the letter on rebuild
   *  (the §18.10.D prompt; reuses the existing cost-share-override controls). */
  strengthenableFields: Array<"deductible" | "oop" | "network">;
} {
  const byLine = new Map<string, LineRecovery>();
  const capBoundLineIds: string[] = [];
  const strengthenable = new Set<"deductible" | "oop" | "network">();
  let weakened = false;
  let total = 0;
  if (!evidence) return { byLine, total: 0, capBoundLineIds, weakened, strengthenableFields: [] };

  for (const claim of evidence.claims) {
    for (const line of claim.lineItemEvidence) {
      const grounds = groundsForLine(line, claim.claimId);
      if (grounds.length === 0) continue;
      const rawSum = grounds.reduce((s, g) => s + g.dollarAtStake, 0);
      const notRendered = grounds.some((g) => g.type === "service_not_rendered");
      const result = basis.get(line.lineItemId) ?? null;
      const shouldOwe = notRendered ? 0 : result?.shouldOwe ?? null;
      const { capped, capBound } = capLineRaw(line, rawSum, shouldOwe);
      if (capBound) capBoundLineIds.push(line.lineItemId);

      // Attestation IS the basis for a not-rendered line; otherwise the precise dollar is
      // assertable only when the engine result is grounded + assumption-free (§18.10.D).
      const assertable = notRendered ? true : result ? isPreciseDollarAssertable(result) : false;
      if (assertable) total += capped;
      else if (result) {
        // §18.10.D — this line omitted its precise dollar. Offer the USER-FIXABLE inputs
        // (deductible/OOP/network) ONLY when confirming them would actually unlock the dollar.
        // If the line is ALSO blocked by plan data we can't toggle (missing rate, etc.), it stays
        // non-assertable regardless → don't over-promise (the cf91a49e rate-starved case); that
        // gap is the "add plan details" / cold-start lane.
        weakened = true;
        const blockedByPlanData = result.assumptions.some((a) => PROMPT_BLOCKING_FIELDS.has(a.field));
        if (!blockedByPlanData) {
          for (const a of result.assumptions) {
            if (a.field === "deductible_met") strengthenable.add("deductible");
            else if (a.field === "oop_met") strengthenable.add("oop");
            else if (a.field === "network") strengthenable.add("network");
          }
        }
      }

      const refundable = Math.max(0, (line.patientPaid ?? 0) - (shouldOwe ?? 0));
      const refund = Math.min(capped, refundable);
      const writeOff = Math.max(0, capped - refund);

      byLine.set(line.lineItemId, {
        lineItemId: line.lineItemId,
        shouldOwe: round2(shouldOwe ?? 0),
        capped: round2(capped),
        refund: round2(refund),
        writeOff: round2(writeOff),
        assertable,
      });
    }
  }
  return {
    byLine,
    total: round2(total),
    capBoundLineIds,
    weakened,
    strengthenableFields: Array.from(strengthenable),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
