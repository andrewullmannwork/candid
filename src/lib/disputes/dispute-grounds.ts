/**
 * §18 Stage 1 — the DisputeGround model + builder (the unified grounds taxonomy).
 *
 * A `DisputeGround` is ONE structured argument the dispute letter makes. The model
 * WRAPS `LineItemEvidence` (the resolver's rich per-line output) rather than flattening
 * it, so it inherits the plan-benefit citation, the expected/actual/discrepancy math,
 * `patientPaid`, the corroboration signals, and the attestation flag for free.
 *
 * STAGE 1 IS ADDITIVE: nothing calls `buildDisputeGrounds` yet (generate/rerender are
 * untouched) → the golden corpus stays byte-identical. The builder + cap are unit-tested
 * in isolation. Stage 2 points generate+rerender at the builder (kills the $0.00 bug by
 * sourcing findings from `evidence`, not the rerender-nulled `report.findings`). Stage 4
 * plumbs `shouldOwe` so the exposure cap binds (until then it is inert — graceful).
 *
 * `DisputeGroundType` is a SUPERSET of the strength scorer's `DisputeTypeClass`, adding the
 * audit-only detectors Correction 2 keeps (`duplicate`/`unbundling`/`unallocated_balance`).
 * It is DECOUPLED from `classifyDisputeType` so Stage 1 changes ZERO live behavior (strength
 * scoring untouched). The exact ground-derivation is golden-validated against rendering at
 * Stage 3; this is the Stage-1 decomposition. The Stage-3 ask rendering must carry the
 * contracted-rate demand (balance_billing / coverage_contradiction) and the itemized-statement
 * request (with specificity) per [[dispute_process]] §19 — both IN-letter, Andrew-approved copy.
 */
import type { CiteGradeTier } from "./strength-scoring";
import type { DisputeEvidence, LineItemEvidence } from "./evidence-resolver";

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

export interface BuildGroundsResult {
  grounds: DisputeGround[];
  /** Grounds indexed by line — for the per-LINE rendering that preserves byte-exactness
   *  at Stage 3 (the letter iterates lines, each line iterates its grounds). */
  byLine: Map<string, DisputeGround[]>;
}

// Strength order for deterministic rendering + argument priority (strongest first).
const TYPE_ORDER: DisputeGroundType[] = [
  "service_not_rendered",
  "balance_billing",
  "duplicate",
  "unbundling",
  "coverage_contradiction",
  "cost_share_misapplication",
  "benchmark",
  "unallocated_balance",
  "coding_peer",
];

const TIER_RANK: Record<CiteGradeTier, number> = { verbatim: 3, statute: 2, header: 1 };
function strongerTier(a: CiteGradeTier, b: CiteGradeTier): CiteGradeTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
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
 * Build the dispute-level grounds from the resolved evidence. Pure; no DB, no behavior change.
 * Groups per-line grounds into one ground per (claim, type), strength-ordered, and returns the
 * grounds-by-line index for per-line rendering.
 */
export function buildDisputeGrounds(evidence: DisputeEvidence | null): BuildGroundsResult {
  if (!evidence) return { grounds: [], byLine: new Map() };

  const byKey = new Map<string, DisputeGround>();
  const byLine = new Map<string, DisputeGround[]>();

  for (const claim of evidence.claims) {
    for (const line of claim.lineItemEvidence) {
      const lineGrounds = groundsForLine(line, claim.claimId);
      if (lineGrounds.length === 0) continue;
      const resolvedForLine: DisputeGround[] = [];
      for (const g of lineGrounds) {
        const key = `${claim.claimId}::${g.type}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.lineItemIds.push(...g.lineItemIds);
          existing.lines.push(...g.lines);
          existing.findings.push(...g.findings);
          existing.dollarAtStake = Math.round((existing.dollarAtStake + g.dollarAtStake) * 100) / 100;
          existing.citeGradeTier = strongerTier(existing.citeGradeTier, g.citeGradeTier);
          resolvedForLine.push(existing);
        } else {
          byKey.set(key, g);
          resolvedForLine.push(g);
        }
      }
      byLine.set(line.lineItemId, resolvedForLine);
    }
  }

  const grounds = Array.from(byKey.values()).sort(
    (a, b) =>
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      b.dollarAtStake - a.dollarAtStake ||
      a.claimId.localeCompare(b.claimId),
  );
  return { grounds, byLine };
}

/**
 * §18.5 / Call A — the de-overlapped, exposure-capped TOTAL recovery (drives `amount_disputed`
 * at Stage 4). PER LINE: sum the line's ground dollars, then CAP at the patient's real wrongful
 * loss = `max(patientPaid, patientOwes) − shouldOwe`. `service_not_rendered` resets `shouldOwe→0`
 * (the whole charge is recoverable). `shouldOwe` is OPTIONAL — when absent (Stages 1–3, before the
 * basis-resolution layer is plumbed) the cap is INERT and the raw sum passes through unchanged.
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
      if (shouldOwe == null) {
        total += rawSum; // cap inert (Stages 1–3)
        continue;
      }
      const exposure = Math.max(line.patientPaid ?? 0, line.patientOwes ?? 0);
      const cap = Math.max(0, exposure - shouldOwe);
      const capped = Math.min(rawSum, cap);
      if (capped < rawSum - 0.005) capBoundLineIds.push(line.lineItemId);
      total += capped;
    }
  }
  return { total: Math.round(total * 100) / 100, capBoundLineIds };
}
