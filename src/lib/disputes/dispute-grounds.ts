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
 * `groundsForLine` / `resolveLetterRecovery` (live behind `dispute_grounds_v1`) + the shared
 * per-line cap core `computeLineRecovery`. Each ground maps to a scorer `DisputeTypeClass` via the catalog's
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
import { ANSWERED_REASONS, resolveStillOutstanding } from "../claims/recovery-math";
import { resolvePerLinePatientPaid } from "../claims/effective-totals";
import type { FindingType } from "../billing/types";
import { DISPUTE_GROUND_CATALOG } from "./dispute-ground-catalog";
import { IDENTITY_BENCHMARK_SOURCE } from "../audit/claim-header-arithmetic";

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
  | "coding_peer" // a peer code is paid for the same service
  | "chargemaster" // billed above the provider's OWN published standard/average charge (HPT/AB-1045; Item C)
  | "provider_overpayment"; // S309 F17 — the user PAID above what the bill charged; the provider owes the difference back

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
  /** The ground's RAW recovery (sum of its lines' contributions). The exposure-capped TOTAL
   *  that drives `amount_disputed` is `resolveLetterRecovery.total` (via `computeLineRecovery`). */
  dollarAtStake: number;
  citeGradeTier: CiteGradeTier; // the ground's strongest spine
}

function findingDollar(line: LineItemEvidence, findingType: string): number {
  return (line.auditFindings ?? [])
    .filter((f) => f.type === findingType && !f.dismissed)
    .reduce((s, f) => s + Math.max(0, f.estimatedOvercharge), 0);
}

function buildGroundFindings(line: LineItemEvidence, findingType?: string): GroundFinding[] {
  return (line.auditFindings ?? [])
    .filter((f) => (!findingType || f.type === findingType) && !f.dismissed)
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
  const findingTypes = new Set((line.auditFindings ?? []).filter((f) => !f.dismissed).map((f) => f.type));
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
  if (findingTypes.has("chargemaster")) out.push(mk("chargemaster", findingDollar(line, "chargemaster"), "chargemaster"));
  if (findingTypes.has("unallocated_balance")) out.push(mk("unallocated_balance", findingDollar(line, "unallocated_balance"), "unallocated_balance"));

  // Cost-share vs coverage-contradiction — MUTUALLY EXCLUSIVE; additive over balance_billing.
  // Spine ORDER reconciled with classifyDisputeType (strength-scoring.ts): a denial finding
  // (insurance_underpayment / missing_adjustment) is the documentary spine and OUTRANKS the
  // structural cost-share signal — so the recovery's primary spine ground matches the letter BODY's
  // bucket (classifyDisputeType → li.disputeType), keeping amount_disputed coherent with the asks.
  // Previously `zeroCs || structuralCostShare` was tested FIRST, so a planBenefit+discrepancy line
  // that ALSO carried a denial finding counted the cost-share sliver while the body argued coverage
  // (the divergence). zero_cost_share_overcharge is itself an explicit cost-share FINDING, so absent a
  // denial finding it (and the structural signal) → cost-share. Locked by classifier-parity.ts.
  const zeroCs = findingTypes.has("zero_cost_share_overcharge");
  const coverageContra = findingTypes.has("insurance_underpayment") || findingTypes.has("missing_adjustment");
  const structuralCostShare = !!line.planBenefit && (line.discrepancyAmount ?? 0) > 0;
  if (coverageContra) {
    out.push(mk("coverage_contradiction", findingDollar(line, "insurance_underpayment") + findingDollar(line, "missing_adjustment")));
  } else if (zeroCs || structuralCostShare) {
    out.push(mk("cost_share_misapplication", line.discrepancyAmount ?? findingDollar(line, "zero_cost_share_overcharge")));
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
 * §18.5 / Call A — the per-line cap, used by the shared `computeLineRecovery` core (and thus by
 * `resolveLetterRecovery`) so there is exactly ONE cap implementation (the regression-sensitive
 * crux — no drift). Caps the raw ground sum at the patient's real wrongful loss =
 * `max(patientPaid, patientOwes) − shouldOwe`. `shouldOwe` is null only when no basis is
 * supplied (flag OFF / Stages 1–3) → INERT, raw passes through.
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
 * §18.5 / Call A — the shared per-line recovery core (R3 step 5, refactor-first). Derives the
 * line's grounds, sums their raw dollars, then CAPS at the line's real exposure
 * `max(patientPaid, patientOwes) − shouldOwe`. `service_not_rendered` resets `shouldOwe→0` (the
 * whole charge is recoverable). `shouldOwe` null (flag OFF / no basis) → the cap is INERT, the raw
 * sum passes through. This is the LINE tier's per-line unit; `resolveLetterRecovery` calls it so
 * there is exactly ONE cap implementation (no drift). The set / claim tiers (R3 step 5.1/5.2)
 * aggregate over disjoint pools alongside it.
 *
 * Supersedes the former `computeCappedRecovery` number-map twin (removed R3 step 5.0 — no `src/`
 * caller; `amount_disputed` is driven by `resolveLetterRecovery.total`). Exercised by the builder
 * fixture (C1–C4).
 */
export function computeLineRecovery(
  line: LineItemEvidence,
  claimId: string,
  shouldOwe: number | null,
  excludeTypes?: ReadonlySet<DisputeGroundType>,
): {
  grounds: DisputeGround[];
  rawSum: number;
  notRendered: boolean;
  /** the effective shouldOwe applied to the cap (0 for an attested not-rendered line). */
  shouldOwe: number | null;
  capped: number;
  capBound: boolean;
} {
  // R3 step 5.2 — drop grounds whose finding is handled by the SET tier (a participating multi-line
  // duplicate/unbundling): removal dominates reprice on the line, and the set recovery is counted
  // once elsewhere. `excludeTypes` is empty for single-line / line-scope grounds → byte-identical.
  const grounds = groundsForLine(line, claimId).filter((g) => !excludeTypes?.has(g.type));
  const rawSum = grounds.reduce((s, g) => s + g.dollarAtStake, 0);
  const notRendered = grounds.some((g) => g.type === "service_not_rendered");
  const effectiveShouldOwe = notRendered ? 0 : shouldOwe;
  const { capped, capBound } = capLineRaw(line, rawSum, effectiveShouldOwe);
  return { grounds, rawSum, notRendered, shouldOwe: effectiveShouldOwe, capped, capBound };
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
/** S309 F17 — the byBasis marker for the derived overpayment claim recovery
 *  (paid > charged). Shared with templates.ts so the grouping can never drift
 *  from the producer. */
export const OVERPAYMENT_BENCHMARK_SOURCE = "user_paid_overpayment";

const BLOCKING_ASSUMPTION_FIELDS: ReadonlySet<CostShareAssumption["field"]> = new Set([
  "network",
  "denial",
  "aca_preventive",
  "deductible_applies",
]);
export function isPreciseDollarAssertable(result: CostShareV2Result): boolean {
  // S308 — ANSWERED rows (reason ∈ ANSWERED_REASONS) are facts, not doubts:
  // since S294 made `deductible_applies` ALWAYS-emit (reason plan_document, so
  // the user can SEE the exemption), bare-presence blocking silently made every
  // documented deductible-exempt line non-assertable — letters omitted dollars
  // they were entitled to claim (letter-recovery S1/S2, rotted un-wired).
  // A pending row (insurer_denied, unknown ACA status, unconfirmed network)
  // still blocks exactly as designed.
  return (
    result.shouldOweGrounded &&
    !result.assumptions.some(
      (a) => BLOCKING_ASSUMPTION_FIELDS.has(a.field) && !ANSWERED_REASONS.has(a.reason),
    )
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
 * R3 step 5.1 — a CLAIM-scope recovery (a disjoint pool): a claim-header finding (today only
 * `unallocated_balance`) whose dollars belong to NO single line. SUMMED with the line pool, never
 * de-overlapped. Recorded by resolveLetterRecovery; folded into the totals + argued in the letter
 * at step 5.3.
 */
export interface ClaimRecovery {
  /** R3 step 5.3 — the claim this finding belongs to (per-claim clampBound suppression). */
  claimId: string;
  type: DisputeGroundType;
  findingId: string;
  title: string;
  /** the claim-scope dollar (e.g. the unallocated amount). */
  recovery: number;
  /**
   * S304 — patient already PAID it → ask for it BACK.
   *
   * Was hard-coded 0 on the assumption that an unaccounted balance is always
   * billed-but-unpaid, so the remedy is forgiveness. That holds for a live
   * balance and fails for a settled one: on a receipt paid to $0.00, asking a
   * provider to "write off" money already handed over asks for nothing. Split
   * by the SAME rule the set tier uses — paid dollars refund, the rest is
   * forgiven — rather than a second convention for the claim tier.
   */
  refund: number;
  /** patient still CHARGED it → forgiveness. */
  writeOff: number;
  /**
   * S304 — which route produced the finding, so the letter can state the right
   * thing. Already carried end-to-end on the finding (`AuditFinding` →
   * `claimLevelFindings` → evidence), so this is a pass-through, not new
   * plumbing. `claim_header_identity` = the bill's own arithmetic doesn't
   * close; anything else = the lines don't itemise everything owed.
   */
  benchmarkSource?: string;
  /** S304 — the arithmetic components, so the letter never re-derives the identity. */
  arithmeticGap?: import("@/lib/billing/types").AuditFinding["arithmeticGap"];
}

/**
 * R3 step 5.2 — a LINE_SET-scope recovery (duplicate / unbundling) for a genuine MULTI-LINE set.
 * The set's dollars are counted ONCE here (not per member line); the removed copies are dropped from
 * the line tier (removal dominates). Recorded by resolveLetterRecovery; folded into the totals + the
 * letter at step 5.3.
 */
export interface SetRecovery {
  /** R3 step 5.3 — the claim this set belongs to (per-claim clampBound suppression in the letter). */
  claimId: string;
  type: DisputeGroundType;
  findingId: string;
  title: string;
  /** every line the set finding spans. */
  memberLineItemIds: string[];
  /** the copies that should be removed (duplicate: redundant copies; unbundling: bundled-away). */
  removedLineItemIds: string[];
  /** the set's recovery, counted ONCE, capped at the removed copies' exposure. */
  recovery: number;
  /** removed copies already PAID. */
  refund: number;
  /** removed copies still BILLED → forgiveness. */
  writeOff: number;
  /** R3 step 5.4 (1b) — ≥1 member is attested not-rendered, so the whole-charge not-rendered ask(s)
   *  subsume this set: it is NOT folded into the headline AND the letter skips its set ask (both read
   *  THIS one flag → fold + letter cannot drift). The attested members are argued + folded in the
   *  attested/line tier instead (they are rescued from `removedLineItemIds`); non-attested copies are
   *  dropped (subsumed) — safe-direction, no attestation propagated to a line the user did not attest. */
  attestationSubsumed: boolean;
}

/**
 * Reverse the catalog's `fromFindings` → the ground each finding maps into (used for CLAIM-scope
 * routing in resolveLetterRecovery). Line-scope routing stays in `groundsForLine` until the
 * post-R3 classifier collapse. Built once at module load.
 */
const FINDING_TO_GROUND: ReadonlyMap<FindingType, DisputeGroundType> = (() => {
  const m = new Map<FindingType, DisputeGroundType>();
  for (const [ground, spec] of Object.entries(DISPUTE_GROUND_CATALOG)) {
    for (const f of spec.fromFindings) m.set(f, ground as DisputeGroundType);
  }
  return m;
})();

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
 *
 * R3 step 5.4 (1a) — `recipient` makes the headline fold recipient-aware: the set/claim tiers
 * (duplicate/unbundling/unallocated) fold into `total` ONLY for the `provider` letter (the only
 * recipient that argues them with dollars). The insurer letter raises them as $0 verification
 * asks, so folding there would make `amount_disputed` exceed its letter body. The set/claim
 * ARRAYS always populate (the insurer letter still renders its $0 asks); only the pool fold is
 * gated. Derive it from the resolved letter type via `letterRecipientKind` so the persisted
 * `amount_disputed` and the rendered body agree per recipient.
 */
/**
 * S310 F18 — line-tier grounds whose REFUND the provider (not the insurer)
 * owes back: charges for care not received, and duplicate/unbundled billing.
 * Everything else in the line tier (cost-share misapplication, coverage
 * grounds) refunds through the insurer's reprocessing. Explicit by ground —
 * obligationElements model evidence duties, not money direction, so deriving
 * this from them would be wrong.
 */
const PROVIDER_REFUND_LINE_GROUNDS: ReadonlySet<DisputeGroundType> = new Set([
  "service_not_rendered",
  "duplicate",
  "unbundling",
]);

export function resolveLetterRecovery(
  evidence: DisputeEvidence | null,
  basis: Map<string, CostShareV2Result>,
  recipient: "insurer" | "provider" | "collector",
): {
  byLine: Map<string, LineRecovery>;
  total: number;
  /** R3 step 5.3 — refund pool: Σ over claims of min(Σ refund, claim patientPaid). total =
   *  totalRefund + totalWriteOff (±1¢ from independent rounding of half-cent coinsurance splits). */
  totalRefund: number;
  /** R3 step 5.3 — write-off pool: Σ over claims of min(Σ writeOff, max(claim patientResponsibility,
   *  Σ line patientOwes)). The max() admits the unallocated pool + dodges an under-extracted header. */
  totalWriteOff: number;
  capBoundLineIds: string[];
  /** §18.10.D — a precise dollar was OMITTED on ≥1 line because it rested on a guess. */
  weakened: boolean;
  /** the USER-FIXABLE inputs that, once confirmed, would strengthen the letter on rebuild
   *  (the §18.10.D prompt; reuses the existing cost-share-override controls). */
  strengthenableFields: Array<"deductible" | "oop" | "network">;
  /** R3 step 5.1 — CLAIM-scope recoveries (disjoint pool; unallocated_balance). Recorded here;
   *  folded into the headline total + the letter at step 5.3. */
  claimRecoveries: ClaimRecovery[];
  /** R3 step 5.2 — LINE_SET-scope recoveries (multi-line duplicate / unbundling, counted once). */
  setRecoveries: SetRecovery[];
  /** R3 step 5.3 — claims whose two-pool clamp BOUND (clamped < raw). The letter drops precise
   *  per-bucket dollars for these claims + asks conservatively (§18.10.D path); amount_disputed
   *  stays the clamped value. Empty in the common (no-bind) case. */
  clampBoundClaimIds: string[];
} {
  const byLine = new Map<string, LineRecovery>();
  const capBoundLineIds: string[] = [];
  const strengthenable = new Set<"deductible" | "oop" | "network">();
  let weakened = false;
  // Collector (debt_validation) has no recovery pool — validation, not a dollar dispute.
  if (recipient === "collector" || !evidence)
    return { byLine, total: 0, totalRefund: 0, totalWriteOff: 0, capBoundLineIds, weakened, strengthenableFields: [], claimRecoveries: [], setRecoveries: [], clampBoundClaimIds: [] };

  // R3 step 5.3 — per-claim clamp pools. The two-pool clamp (refund ≤ claim patientPaid; writeOff ≤
  // max(claim patientResponsibility, Σ line patientOwes)) is computed PER CLAIM so a multi-claim
  // dispute (one dispute spanning several visits — roadmap) cannot let one claim's over-read borrow
  // another claim's headroom. For today's single-claim disputes with no set/claim findings + no
  // binding clamp, total reduces to round2(Σ assertable capped) → byte-identical. `lineOwes` sums ALL
  // the claim's lines (incl. removed copies — the set tier's write-off comes from them).
  // S309 F12 — the letter's per-line money basis is the SAME shared derivation
  // the claim page uses (resolvePerLinePatientPaid / resolveStillOutstanding).
  // Single-adjudication provider bills carry null per-line paid/owes BY DESIGN
  // (S304 — the header states adjudication once); reading them raw zeroed
  // `refundable`, so every such letter fell to the generic-relief branch while
  // the claim panel asserted the recovery (the S294/#289 under-claim class,
  // live-caught in the S309 retest: panel $67.18, letter generic). Applied
  // ONCE here and consumed by the RECOVERY math only — citation fields keep
  // reading the raw cite-grade columns untouched.
  const effMoney = new Map<string, { paid: number; owes: number }>();
  for (const claim of evidence.claims) {
    for (const l of claim.lineItemEvidence) {
      const paid = resolvePerLinePatientPaid({
        lineBilled: l.billedAmount,
        linePatientPaid: l.patientPaid,
        claimTotalBilled: claim.totalBilled,
        effectiveClaimPatientPaid: claim.effectiveTotals,
      }).value;
      const owes =
        l.patientOwes != null
          ? l.patientOwes
          : resolveStillOutstanding({
              lineBilled: l.billedAmount,
              lineStillOutstanding: null,
              linePatientOwes: null,
              claimTotalBilled: claim.totalBilled,
              claimStillOutstanding: claim.effectiveTotals.patientResponsibility,
            });
      effMoney.set(l.lineItemId, { paid, owes });
    }
  }
  const effLine = (l: LineItemEvidence): LineItemEvidence => {
    const m = effMoney.get(l.lineItemId);
    return m ? { ...l, patientPaid: m.paid, patientOwes: m.owes } : l;
  };

  // S310 F18 (Andrew) — a letter's total is the sum of the demands its own
  // body makes. The refund pool splits by WHO owes the money back: cost-share
  // and coverage refunds are the INSURER letter's demand (the fix is
  // reprocessing), while a not-rendered or duplicate/unbundling refund is the
  // PROVIDER's (they charged for what they shouldn't have). The write-off pool
  // is provider/collector-side by construction — the balance is theirs to stop
  // billing ("Provider must forgive"). This completes the recipient-aware fold
  // the set + claim tiers (5.4 1a) already follow; before it, the provider
  // letter's amount_disputed headlined the insurer letter's money (live-caught
  // S310: provider row 127.47 vs its own 60.29 claim).
  type ClaimPool = { refundInsurerRaw: number; refundProviderRaw: number; writeOffRaw: number; paidCap: number; respHeader: number; lineOwes: number };
  const pools = new Map<string, ClaimPool>();
  for (const claim of evidence.claims) {
    pools.set(claim.claimId, {
      refundInsurerRaw: 0,
      refundProviderRaw: 0,
      writeOffRaw: 0,
      paidCap: claim.effectiveTotals.patientPaid,
      respHeader: claim.effectiveTotals.patientResponsibility,
      lineOwes: claim.lineItemEvidence.reduce(
        (s, l) => s + Math.max(0, effMoney.get(l.lineItemId)?.owes ?? l.patientOwes ?? 0),
        0,
      ),
    });
  }

  // R3 step 5.2 — SET tier pre-pass. Group LINE_SET-scope findings (duplicate / unbundling) by
  // findingId across the claim. A finding on ≥2 lines is a genuine multi-line set → its dollars are
  // counted ONCE (the SET tier) and its removed copies drop from the line tier. A set-scope finding
  // on a SINGLE line stays in the line tier (byte-identical — nothing to remove / de-duplicate).
  type SetAgg = {
    claimId: string;
    groundType: DisputeGroundType;
    title: string;
    overcharge: number;
    lineIds: Set<string>;
    removedLineIds: Set<string>;
  };
  const setAgg = new Map<string, SetAgg>();
  // S309 F12 — lineById stores the EFFECTIVE-money view (set-tier exposure /
  // paid sums read it), so the set tier and the line tier price lines the
  // same way.
  const lineById = new Map<string, LineItemEvidence>();
  for (const claim of evidence.claims) {
    for (const line of claim.lineItemEvidence) {
      lineById.set(line.lineItemId, effLine(line));
      for (const f of line.auditFindings ?? []) {
        if (!f.findingId || f.dismissed) continue; // R3 step 5.3 — skip user-dismissed findings
        const ground = FINDING_TO_GROUND.get(f.type as FindingType);
        if (!ground || DISPUTE_GROUND_CATALOG[ground].scope !== "line_set") continue;
        let agg = setAgg.get(f.findingId);
        if (!agg) {
          agg = { claimId: claim.claimId, groundType: ground, title: f.title, overcharge: 0, lineIds: new Set(), removedLineIds: new Set() };
          setAgg.set(f.findingId, agg);
        }
        agg.lineIds.add(line.lineItemId);
        agg.overcharge = Math.max(agg.overcharge, f.estimatedOvercharge);
        // R3 step 5.4 (1b) — an attested not-rendered line is NEVER a removed copy: it is rescued to
        // the attested/line tier (its strongest, attestation-backed ground) instead of being dropped.
        // The line stays a set MEMBER (so the set forms + attestationSubsumed below detects it), but it
        // is excluded from removedLineIds → it reaches the attested bucket in the letter + folds as
        // not-rendered. Non-attested sets are unaffected (the guard is always true) → byte-identical.
        if (f.removed && !line.serviceNotRenderedAttested) agg.removedLineIds.add(line.lineItemId);
      }
    }
  }
  const participatingSets = Array.from(setAgg.entries()).filter(([, a]) => a.lineIds.size >= 2);
  const removedLineIds = new Set<string>();
  const excludeTypesByLine = new Map<string, Set<DisputeGroundType>>();
  for (const [, a] of participatingSets) {
    for (const id of a.removedLineIds) removedLineIds.add(id);
    for (const id of a.lineIds) {
      const s = excludeTypesByLine.get(id) ?? new Set<DisputeGroundType>();
      s.add(a.groundType);
      excludeTypesByLine.set(id, s);
    }
  }

  // S326 (member_composition_v1) — the member-exclusion set: every ground NOT
  // selected. The evidence lines are already scope-filtered at build (findings /
  // attestation / peer masks), so this catches the residual class — grounds
  // groundsForLine derives from UNMASKED line signals (the planBenefit-driven
  // structural cost-share / coverage pushes; planBenefit itself stays on the
  // line deliberately — it is citation data, not an argued ground). Null scope
  // → empty set → byte-identical.
  const memberExclude = new Set<DisputeGroundType>(
    evidence.compositionScope == null
      ? []
      : (Object.keys(DISPUTE_GROUND_CATALOG) as DisputeGroundType[]).filter(
          (g) => !evidence.compositionScope!.includes(g),
        ),
  );

  for (const claim of evidence.claims) {
    const pool = pools.get(claim.claimId);
    for (const rawLine of claim.lineItemEvidence) {
      if (removedLineIds.has(rawLine.lineItemId)) continue; // removed copy — removal dominates (line tier)
      // S309 F12 — the line tier computes on the effective-money view.
      const line = effLine(rawLine);
      const result = basis.get(line.lineItemId) ?? null;
      // S326 — the set-tier excludes union the member exclusions (one filter
      // mechanism, two legitimate sources; empty member set when unscoped).
      const setExcludes = excludeTypesByLine.get(line.lineItemId);
      const lineExcludes =
        memberExclude.size === 0
          ? setExcludes
          : new Set<DisputeGroundType>([...(setExcludes ?? []), ...memberExclude]);
      const { grounds, notRendered, shouldOwe, capped, capBound } = computeLineRecovery(
        line,
        claim.claimId,
        result?.shouldOwe ?? null,
        lineExcludes,
      );
      if (grounds.length === 0) continue;
      if (capBound) capBoundLineIds.push(line.lineItemId);

      // Attestation IS the basis for a not-rendered line; otherwise the precise dollar is
      // assertable only when the engine result is grounded + assumption-free (§18.10.D).
      const assertable = notRendered ? true : result ? isPreciseDollarAssertable(result) : false;

      const refundable = Math.max(0, (line.patientPaid ?? 0) - (shouldOwe ?? 0));
      const refund = Math.min(capped, refundable);
      const writeOff = Math.max(0, capped - refund);
      // S310 F18 — the line's refund family (see the pool comment above). A
      // line carrying any provider-refund ground routes its refund to the
      // provider pool (removal dominates reprice — the existing precedence).
      const providerRefundLine = grounds.some((g) => PROVIDER_REFUND_LINE_GROUNDS.has(g.type));

      if (assertable) {
        // R3 step 5.3 — refund + writeOff === capped → the pool sum equals the former `total += capped`.
        if (pool) {
          if (providerRefundLine) pool.refundProviderRaw += refund;
          else pool.refundInsurerRaw += refund;
          pool.writeOffRaw += writeOff;
        }
      } else if (result) {
        // §18.10.D — this line omitted its precise dollar. Offer the USER-FIXABLE inputs
        // (deductible/OOP/network) ONLY when confirming them would actually unlock the dollar.
        // If the line is ALSO blocked by plan data we can't toggle (missing rate, etc.), it stays
        // non-assertable regardless → don't over-promise (the cf91a49e rate-starved case); that
        // gap is the "add plan details" / cold-start lane.
        weakened = true;
        // S308 (tracker AU) — an ANSWERED rate (reason ∈ ANSWERED_REASONS) is a
        // known value, not missing plan data; only PENDING assumptions block.
        const blockedByPlanData = result.assumptions.some(
          (a) => PROMPT_BLOCKING_FIELDS.has(a.field) && !ANSWERED_REASONS.has(a.reason),
        );
        if (!blockedByPlanData) {
          for (const a of result.assumptions) {
            if (a.field === "deductible_met") strengthenable.add("deductible");
            else if (a.field === "oop_met") strengthenable.add("oop");
            else if (a.field === "network") strengthenable.add("network");
          }
        }
      }

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

  // R3 step 5.2 — SET tier: each participating multi-line set (duplicate / unbundling) contributes
  // its recovery ONCE (the redundant / bundled-away copies), capped at the removed copies' exposure,
  // split refund (copies already paid) vs writeOff (copies still billed). Recorded here; folded into
  // the totals + the letter at step 5.3 (headline-inert now → golden-48 byte-identical).
  const setRecoveries: SetRecovery[] = [];
  for (const [findingId, a] of participatingSets) {
    // R3 step 5.4 (1b) — does any member attest the service was not rendered? If so, the whole-charge
    // not-rendered ask(s) subsume this set: skip the headline fold here AND (via this flag on the
    // pushed SetRecovery) the letter's set ask. ONE source → fold + letter cannot drift.
    const attestationSubsumed = Array.from(a.lineIds).some(
      (id) => lineById.get(id)?.serviceNotRenderedAttested === true,
    );
    const removed = Array.from(a.removedLineIds)
      .map((id) => lineById.get(id))
      .filter((l): l is LineItemEvidence => !!l);
    // No removed copies marked (old data pre-5.2): de-dup still applies (count once); fall back to
    // the whole set for the exposure basis since we can't yet tell survivor from copy.
    const exposureLines =
      removed.length > 0
        ? removed
        : Array.from(a.lineIds).map((id) => lineById.get(id)).filter((l): l is LineItemEvidence => !!l);
    const exposure = exposureLines.reduce((s, l) => s + Math.max(l.patientPaid ?? 0, l.patientOwes ?? 0), 0);
    const recoveryRaw = Math.min(a.overcharge, exposure);
    const insurerPaid = exposureLines.reduce((s, l) => s + (l.insurancePaid ?? 0), 0);
    // R3 step 5.3 — keep a $0-patient-exposure set when the INSURER paid the duplicate (the letter
    // raises an insurer-recoup review, $0 to the pools); drop only a truly-empty set.
    if (recoveryRaw <= 0 && insurerPaid <= 0) continue;
    const paid = exposureLines.reduce((s, l) => s + (l.patientPaid ?? 0), 0);
    const refundRaw = Math.max(0, Math.min(recoveryRaw, paid));
    const writeOffRaw = Math.max(0, recoveryRaw - refundRaw);
    // R3 step 5.3 — fold (raw) into the set's OWN claim pool; round for the recorded SetRecovery.
    // R3 step 5.4 (1a) — recipient-aware: set-tier dollars fold into the headline ONLY for the
    // provider letter (the only recipient that argues them with dollars). The insurer letter
    // raises a $0 verification ask, so folding here would make amount_disputed exceed its letter
    // body. The setRecoveries array still populates below → the insurer letter renders its $0 ask.
    // R3 step 5.4 (1b) — also skip the fold when an attested member subsumes the set (the attested
    // line is folded as not-rendered in the line tier instead; folding here too would double-count).
    const setPool = pools.get(a.claimId);
    if (setPool && recipient === "provider" && !attestationSubsumed) {
      setPool.refundProviderRaw += refundRaw;
      setPool.writeOffRaw += writeOffRaw;
    }
    setRecoveries.push({
      claimId: a.claimId,
      type: a.groundType,
      findingId,
      title: a.title,
      memberLineItemIds: Array.from(a.lineIds),
      removedLineItemIds: Array.from(a.removedLineIds),
      recovery: round2(recoveryRaw),
      refund: round2(refundRaw),
      writeOff: round2(writeOffRaw),
      attestationSubsumed,
    });
  }

  // R3 step 5.1 — CLAIM tier: claim-header findings (unallocated_balance) form a pool DISJOINT
  // from the line pool (dollars on no line) → recorded here, SUMMED into the totals + argued in
  // the letter at step 5.3 (NOT folded into `total` yet → this step is headline-inert; golden-48
  // has no claim findings so it stays byte-identical). Routed via the catalog scope, not a
  // hardcoded finding name.
  const claimRecoveries: ClaimRecovery[] = [];
  for (const claim of evidence.claims) {
    for (const f of claim.claimFindings ?? []) {
      if (f.dismissed || !f.actionable) continue;
      const ground = FINDING_TO_GROUND.get(f.type);
      if (!ground || DISPUTE_GROUND_CATALOG[ground].scope !== "claim") continue;
      const recoveryRaw = Math.max(0, f.estimatedOvercharge);
      if (recoveryRaw <= 0) continue;
      // R3 step 5.3 — unallocated is billed (not shown paid) → the claim's write-off pool.
      // R3 step 5.4 (1a) — recipient-aware fold (see set-tier note): claim-tier dollars fold into
      // the headline ONLY for the provider letter; the claimRecoveries array still populates below.
      // S304 — refund vs forgiveness, and the evidence bar for calling it a refund.
      //
      // The default stays FORGIVENESS: an unallocated balance is an un-itemised
      // charge, and whether the patient has paid THAT charge is not knowable
      // from claim totals. The first cut here used `min(recovery, totalPaid)`,
      // borrowing the set tier's rule — and the golden fixture caught it: the
      // claim's total paid is already the evidence backing the LINE tier's
      // refunds, so spending it again clamped the claim dollars away entirely
      // (F1: line 100 + set 80 + claim 50 came out 180, not 230). Total-paid is
      // not proof that a specific unaccounted amount was paid.
      //
      // The IDENTITY path is the one case where it IS proof. That path only
      // fires when the per-line charges reconcile with the bill's own total, so
      // the document is complete; when the bill is ALSO settled — patient paid
      // covers the full responsibility — every dollar it charged is out of
      // pocket, including the unaccounted one. Asking a provider to "write off"
      // money already handed over on a $0.00 balance asks for nothing.
      const claimPool = pools.get(claim.claimId);
      const settled =
        f.benchmarkSource === IDENTITY_BENCHMARK_SOURCE &&
        claim.effectiveTotals.patientPaid >= claim.effectiveTotals.patientResponsibility - 0.005;
      const refundRaw = settled ? recoveryRaw : 0;
      const writeOffRaw = settled ? 0 : recoveryRaw;
      if (claimPool && recipient === "provider") {
        claimPool.refundProviderRaw += refundRaw;
        claimPool.writeOffRaw += writeOffRaw;
      }
      claimRecoveries.push({
        claimId: claim.claimId,
        type: ground,
        findingId: f.id,
        title: f.title,
        recovery: round2(recoveryRaw),
        refund: round2(refundRaw),
        writeOff: round2(writeOffRaw),
        benchmarkSource: f.benchmarkSource,
        arithmeticGap: f.arithmeticGap,
      });
    }

    // S309 F17 (Andrew's design) — the OVERPAYMENT tier: what the user paid
    // ABOVE what the bill charged. Derived, not stored (the stored fact is
    // claims.metadata.userPatientPaid; effectiveTotals already carries it via
    // the Z1.1d overlay), and a CLAIM-scope element like unallocated_balance:
    // it has no line, no plan-term ground, and it obligates the PROVIDER —
    // pure refund (the money is out of pocket by definition). The insurer
    // letter never folds it (recipient guard, same as every claim-tier
    // dollar); the provider letter's request block renders its own statement
    // (templates byBasis "user_paid_overpayment") with the EXISTING
    // refund-the-difference remedy.
    const overpaid = round2(
      Math.max(0, claim.effectiveTotals.patientPaid - claim.effectiveTotals.patientResponsibility),
    );
    if (overpaid >= 1) {
      const claimPool = pools.get(claim.claimId);
      if (claimPool && recipient === "provider") claimPool.refundProviderRaw += overpaid;
      claimRecoveries.push({
        claimId: claim.claimId,
        type: "provider_overpayment",
        findingId: `overpayment:${claim.claimId}`,
        title: "Paid above the billed amount",
        recovery: overpaid,
        refund: overpaid,
        writeOff: 0,
        benchmarkSource: OVERPAYMENT_BENCHMARK_SOURCE,
        arithmeticGap: undefined,
      });
    }
  }

  // R3 step 5.3 — fold + two-pool clamp (per claim), then sum. total = totalRefund + totalWriteOff.
  // A claim whose clamp BINDS (clamped < raw) is recorded so the letter degrades gracefully (drops
  // precise per-bucket dollars, asks conservatively); amount_disputed still uses the clamped value.
  const clampBoundClaimIds: string[] = [];
  let totalRefundRaw = 0;
  let totalWriteOffRaw = 0;
  for (const [claimId, p] of pools) {
    // S310 F18 — each recipient's totals count only the demands ITS letter
    // makes: the insurer letter claims the insurer-family refunds and never a
    // write-off (an insurer doesn't hold the balance; its fix is reprocessing);
    // the provider/collector letter claims the provider-family refunds + the
    // write-offs. Clamps unchanged, applied to the recipient's own raws.
    const refundRaw = recipient === "insurer" ? p.refundInsurerRaw : p.refundProviderRaw;
    const writeOffRaw = recipient === "insurer" ? 0 : p.writeOffRaw;
    const clampedRefund = Math.min(refundRaw, p.paidCap);
    const clampedWriteOff = Math.min(writeOffRaw, Math.max(p.respHeader, p.lineOwes));
    if (clampedRefund < refundRaw - 0.005 || clampedWriteOff < writeOffRaw - 0.005) {
      clampBoundClaimIds.push(claimId);
    }
    totalRefundRaw += clampedRefund;
    totalWriteOffRaw += clampedWriteOff;
  }

  return {
    byLine,
    total: round2(totalRefundRaw + totalWriteOffRaw),
    totalRefund: round2(totalRefundRaw),
    totalWriteOff: round2(totalWriteOffRaw),
    capBoundLineIds,
    weakened,
    strengthenableFields: Array.from(strengthenable),
    claimRecoveries,
    setRecoveries,
    clampBoundClaimIds,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** R3 step 5.3 — the full recovery result (byLine + fold/clamp pools + set/claim tiers + clampBound).
 *  buildRequestSection consumes it to argue the set/claim grounds + degrade on a bound clamp. */
export type LetterRecoveryResult = ReturnType<typeof resolveLetterRecovery>;

/**
 * S312 (F2-S312.1, Andrew's ruling) — "this letter may no longer be needed."
 *
 * TRUE when the letter's OWN recipient-scoped demand has fallen to nothing:
 * the fold total is $0, no dollar was merely HIDDEN behind an unconfirmed
 * assumption (`weakened` letters still argue their asks and prompt the user to
 * strengthen — hidden is not gone), and no zero-dollar set-tier ask survives
 * (the insurer letter's duplicate/unbundling burden-shift asks are DELIBERATELY
 * $0 and still real asks; an attestation-subsumed set is argued nowhere, so it
 * doesn't count). Claim-tier rows need no separate check: provider-side they
 * fold into `total`, insurer-side they are never argued.
 *
 * Reads ONLY the fold's outputs — the same object the letter's asks and
 * `amount_disputed` render from — so the banner can never disagree with the
 * letter's own body (one derivation). Liveness (never-sent draft), the
 * dispute_draft_live_rebuild_v1 gate, and the user's standing "Keep letter"
 * answer are the ROUTE's business; this predicate is pure demand math.
 */
export function noRemainingLetterDemand(recovery: LetterRecoveryResult): boolean {
  return (
    recovery.total === 0 &&
    !recovery.weakened &&
    !recovery.setRecoveries.some((s) => !s.attestationSubsumed) &&
    // Fail-closed twin of `weakened` (its own fixture caught this): a line whose
    // engine basis is MISSING drops its dollars without setting `weakened`
    // (resolveLetterRecovery only marks weakened when a result exists). A line
    // still carrying an unassertable non-zero demand means dollars were dropped,
    // not settled — never "no longer needed". Showing the banner wrongly kills a
    // real letter; missing it costs nothing.
    !Array.from(recovery.byLine.values()).some((r) => !r.assertable && r.capped > 0)
  );
}
