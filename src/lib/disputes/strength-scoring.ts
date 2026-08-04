/**
 * Dispute strength scoring — Block A of the Dispute Letter Overhaul arc.
 *
 * Single source of truth for "how strong is this dispute?" Consumed by the
 * dispute-letter API (additive `strength` payload) and, behind the
 * `dispute_letter_v3_design` flag, by the data-trust HARD STOP that suppresses
 * letter generation for bills we couldn't reconcile.
 *
 * THREE INDEPENDENT AXES — never collapsed to one scalar
 * (plans/dispute_letter_overhaul.md §1a):
 *
 *   (a) data trust — can we trust the parsed bill at all? Per-bill GATE.
 *                    header_reconciliation_failed → HARD STOP;
 *                    bill_parser_sign_violation   → WARN.
 *   (b) evidence   — how provable / hard-to-rebut is the case? Per-line,
 *                    dispute-type-aware, money-weighted; rendered as a
 *                    qualitative BAND, never odds of winning (legal L1).
 *   (c) readiness  — has the user supplied what's needed to SEND it?
 *                    MVDL-required floor + open optional ("make it stronger") items.
 *
 * Pure + side-effect-free: no I/O, computed once server-side, consumed by both
 * letter generation and UI. Weights + thresholds are config-tunable (Ship Gate
 * G6) via the `dispute_strength_config` flag; the code defaults below are the
 * §1e starting calibration. Safe defaults everywhere — $0-stake lines, empty
 * evidence, and divide-by-zero all resolve to "Needs support" / "Attention" and
 * NEVER crash, NEVER default to "Well-supported" / "Airtight" (§1e).
 *
 * Legal guardrails (§1f): strength is evidence-QUALITY, never outcome odds (L1).
 * The qualitative band is the only public surface; the numeric score is an
 * internal calibration signal.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DisputeEvidence, LineItemEvidence } from "./evidence-resolver";
import { recipientAddressGapKindFor } from "./letter-type";

// ============================================================================
// Axis (a) — data-trust gate
// ============================================================================

export type DataTrustGate = "pass" | "warn" | "hard_stop";

export interface DataTrustState {
  gate: DataTrustGate;
  /** Set only when gate === 'hard_stop'. Drives the API blocked-reason + banner. */
  reason: "bill_reconciliation_pending" | null;
  /** True when any bill on this dispute carries a sign-convention warning. */
  signViolation: boolean;
}

/**
 * Evaluate the per-bill data-trust gate across every claim on the dispute.
 * Precedence: header-reconciliation failure (HARD STOP) outranks a sign-
 * convention warning (§1a "both set → recon-failed precedence"). Absent signal
 * (clean bill, or no evidence resolved) → pass.
 */
export function evaluateDataTrust(
  evidence: DisputeEvidence | null | undefined,
): DataTrustState {
  const claims = evidence?.claims ?? [];
  const anyReconFail = claims.some(
    (c) => c.dataTrust?.headerReconciliationFailed === true,
  );
  const anySign = claims.some((c) => c.dataTrust?.signViolation === true);
  if (anyReconFail) {
    return {
      gate: "hard_stop",
      reason: "bill_reconciliation_pending",
      signViolation: anySign,
    };
  }
  if (anySign) return { gate: "warn", reason: null, signViolation: true };
  return { gate: "pass", reason: null, signViolation: false };
}

// ============================================================================
// Axis (b) — evidence taxonomy, weights, scoring (§1d / §1e)
// ============================================================================

/** §1e dispute-type spine taxonomy (per-line classification). */
export type DisputeTypeClass =
  | "coverage_contradiction"
  | "balance_billing"
  | "cost_share_misapplication"
  | "coding_peer"
  | "coverage_corroboration"
  | "benchmark"
  | "service_not_rendered"
  /** Safe default for finding types with no §1e spine (duplicate, stale_claim,
   *  unallocated_balance, uncategorized_service) — scored at the inferred tier. */
  | "other";

export type ProbativeTier = "documentary" | "statistical" | "inferred";

/** §1e citeGradeFactor buckets — the spine signal's citation grade. */
export type CiteGradeTier = "verbatim" | "header" | "statute";

export type EvidenceBand =
  | "needs_support"
  | "partially_supported"
  | "well_supported";

export type ReadinessState = "attention" | "ready_to_send" | "airtight";

/**
 * Who the finished letter is addressed to — drives which mailing address(es) the
 * readiness floor (MVDL #3) actually requires. An insurer appeal must not be
 * blocked by a missing *provider* address it never prints, and vice-versa.
 * `both`/undefined → require either is missing fails (the conservative legacy
 * behavior). Derived from the letter type by `letterRecipientKind` in
 * src/lib/disputes/index.ts (single source of truth, shared with the templates).
 */
// S301 — "collector" USED to fall to the conservative else-branch below, which required BOTH the
// insurer appeals address AND the provider address on a debt-validation letter that prints
// neither. Because `provider_address_missing` fired for every non-appeal letter, any collections
// letter on a claim without a clinic address failed MVDL #3 and was reported "Not ready to send"
// for an address it never mails to. Under `letter_requirements_v1` the required address comes from
// `letterNeeds`, which is the machine image of the composer's own recipient decision.
// "both" remains for the legacy/undefined caller.
export type RecipientKind = "insurer" | "provider" | "both" | "collector";

export interface StrengthWeights {
  probativeTier: Record<ProbativeTier, number>;
  citeGradeFactor: Record<CiteGradeTier, number>;
  categoryWeight: { spine: number; boost: number; benchmark: number };
}

export interface StrengthThresholds {
  /** evidenceScore ≥ this → 'partially_supported' (else 'needs_support'). */
  partiallySupported: number;
  /** evidenceScore ≥ this → 'well_supported'. */
  wellSupported: number;
}

export interface StrengthConfig {
  weights: StrengthWeights;
  thresholds: StrengthThresholds;
}

/**
 * §1e starting calibration. DO NOT over-tune pre-data — ship the structure,
 * calibrate post-launch from outcome priors. Overridable at runtime via the
 * `dispute_strength_config` flag (Ship Gate G6).
 */
export const DEFAULT_STRENGTH_WEIGHTS: StrengthWeights = {
  probativeTier: { documentary: 1.0, statistical: 0.6, inferred: 0.4 },
  citeGradeFactor: { verbatim: 1.0, header: 0.7, statute: 0.5 },
  categoryWeight: { spine: 1.0, boost: 0.5, benchmark: 0.4 },
};

export const DEFAULT_STRENGTH_THRESHOLDS: StrengthThresholds = {
  partiallySupported: 0.34,
  wellSupported: 0.67,
};

export const DEFAULT_STRENGTH_CONFIG: StrengthConfig = {
  weights: DEFAULT_STRENGTH_WEIGHTS,
  thresholds: DEFAULT_STRENGTH_THRESHOLDS,
};

/** The probative tier of each dispute type's SPINE evidence (§1d / §1e). */
const SPINE_TIER: Record<DisputeTypeClass, ProbativeTier> = {
  coverage_contradiction: "documentary",
  balance_billing: "documentary",
  cost_share_misapplication: "documentary",
  service_not_rendered: "documentary",
  coding_peer: "statistical",
  coverage_corroboration: "statistical",
  benchmark: "statistical",
  other: "inferred",
};

// ---- per-line derivation (the "EvidenceBundle normalization") --------------
// These run in the resolver to populate the additive LineItemEvidence fields,
// and are re-exported so the resolver is the single producer + this module is
// the single definition of the taxonomy.

type ClassifyInput = Pick<
  LineItemEvidence,
  | "planBenefit"
  | "peerCodes"
  | "communityOutcome"
  | "siblingCodes"
  | "pricingBenchmark"
  | "auditFindings"
  | "discrepancyAmount"
>;

/**
 * Map a line's evidence signals → §1e dispute-type spine. Per-line audit-finding
 * types take priority (most specific); structural signals break ties; 'other'
 * for lines with no §1e-mapped signal. `service_not_rendered` is reserved for
 * the attestation signal (Block C) and does not fire in Block A.
 */
export function classifyDisputeType(li: ClassifyInput): DisputeTypeClass {
  const findingTypes = new Set((li.auditFindings ?? []).map((f) => f.type));

  // Documentary / legal spines first.
  if (findingTypes.has("balance_billing")) return "balance_billing";
  if (
    findingTypes.has("insurance_underpayment") ||
    findingTypes.has("missing_adjustment")
  ) {
    return "coverage_contradiction";
  }
  if (findingTypes.has("zero_cost_share_overcharge")) {
    return "cost_share_misapplication";
  }

  // Benchmark-class findings (statistical).
  if (
    findingTypes.has("overcharge") ||
    findingTypes.has("upcoding") ||
    findingTypes.has("unbundling") ||
    findingTypes.has("chargemaster")
  ) {
    return "benchmark";
  }

  // Structural signals when no finding type pinned it.
  if (li.planBenefit && (li.discrepancyAmount ?? 0) > 0) {
    return "cost_share_misapplication";
  }
  if (li.planBenefit) return "coverage_contradiction";
  if (li.peerCodes && li.peerCodes.length >= 2) return "coding_peer";
  if (li.communityOutcome) return "coverage_corroboration";
  if (li.pricingBenchmark) return "benchmark";

  return "other";
}

type CiteGradeInput = Pick<LineItemEvidence, "planBenefit">;

/**
 * The spine signal's citation grade (§1e citeGradeFactor):
 *   verbatim — cite-grade Pattern P-8 verified plan quote
 *   header   — plan data present but not verbatim-verified (paraphrased / header-only)
 *   statute  — no plan quote (case rests on statute / EOB allowed-amount)
 */
export function deriveCiteGradeTier(li: CiteGradeInput): CiteGradeTier {
  if (li.planBenefit?.sbcExcerptVerified === true) return "verbatim";
  if (li.planBenefit) return "header";
  return "statute";
}

type StakeInput = Pick<LineItemEvidence, "discrepancyAmount" | "auditFindings">;

/**
 * Per-line dollar-at-stake — the §1a money weight `w_i` (recovery + forgiveness
 * proxy). Block A derives it from the resolver's `discrepancyAmount` (cost-share
 * overpay) and the audit findings' `estimatedOvercharge`, taking the max to
 * avoid double-counting when a finding restates the discrepancy. The precise
 * recovery/forgiveness split (split-fix.ts) lands in Block C and can refine
 * this. Always ≥ 0.
 */
export function deriveDollarAtStake(li: StakeInput): number {
  const discrepancy = Math.max(0, li.discrepancyAmount ?? 0);
  const overcharge = (li.auditFindings ?? []).reduce(
    (sum, f) => sum + Math.max(0, f.estimatedOvercharge ?? 0),
    0,
  );
  return Math.max(discrepancy, overcharge);
}

// ---- per-line scoring ------------------------------------------------------

export interface PerLineScore {
  lineItemId: string;
  disputeType: DisputeTypeClass;
  citeGradeTier: CiteGradeTier;
  dollarAtStake: number;
  /** Line evidence score in [0,1]. Internal — never surfaced raw to the client (L1). */
  score: number;
  /** Block C2 — qualitative band for this line (the client's per-line readout;
   *  L1: bands only, never the score). Derived from `score` via the same §1e
   *  thresholds as the letter-level aggregate. */
  band: EvidenceBand;
  /** False when the dispute type's spine evidence is absent — the readiness
   *  rail surfaces these as "back up this charge" (§1a). */
  spinePresent: boolean;
}

/** Whether the dispute type's spine evidence is actually present on the line. */
function isSpinePresent(
  li: LineItemEvidence,
  disputeType: DisputeTypeClass,
): boolean {
  switch (disputeType) {
    case "coverage_contradiction":
    case "cost_share_misapplication":
      return !!li.planBenefit;
    case "balance_billing":
      // EOB / insurer-side numbers present (allowed-amount argument).
      return li.insurancePaid != null || li.patientOwes != null;
    case "coding_peer":
      return !!(li.peerCodes && li.peerCodes.length >= 2);
    case "coverage_corroboration":
      return !!li.communityOutcome;
    case "benchmark":
      return (
        !!li.pricingBenchmark ||
        (li.auditFindings ?? []).some((f) => f.benchmarkAmount != null)
      );
    case "service_not_rendered":
      // Block C2 — spine present iff the user attested (under their own name)
      // that this service was not rendered. The attestation IS the documentary
      // spine (§1d); no signal-derived evidence is required.
      return !!li.serviceNotRenderedAttested;
    case "other":
    default:
      return false;
  }
}

/**
 * §1a per-line score: lineScore = min(1, Σ probativeTier × citeGradeFactor ×
 * categoryWeight) over the line's evidence signals. The dispute type selects
 * which signal is the spine (full citeGradeFactor); corroborating statistical
 * signals enter as boosts; pricing enters as a benchmark. citeGradeFactor only
 * grades the documentary spine quote — statistical boosts aren't quote-based, so
 * they enter at full statistical weight.
 */
/** Map a line/aggregate score in [0,1] to its qualitative band (§1e thresholds). */
function bandForScore(score: number, thresholds: StrengthThresholds): EvidenceBand {
  return score >= thresholds.wellSupported
    ? "well_supported"
    : score >= thresholds.partiallySupported
      ? "partially_supported"
      : "needs_support";
}

function scoreLine(
  li: LineItemEvidence,
  weights: StrengthWeights,
  thresholds: StrengthThresholds,
): PerLineScore {
  const disputeType: DisputeTypeClass = li.disputeType ?? "other";
  const citeGradeTier: CiteGradeTier = li.citeGradeTier ?? "statute";
  const dollarAtStake = Math.max(0, li.dollarAtStake ?? 0);

  const terms: number[] = [];

  // Spine term — the dispute type's primary evidence, graded by citation tier.
  const spinePresent = isSpinePresent(li, disputeType);
  if (spinePresent) {
    const tier = SPINE_TIER[disputeType];
    terms.push(
      weights.probativeTier[tier] *
        weights.citeGradeFactor[citeGradeTier] *
        weights.categoryWeight.spine,
    );
  }

  // Boost terms — corroborating statistical signals, independent of the spine.
  let boosts = 0;
  if (li.peerCodes && li.peerCodes.length >= 2 && disputeType !== "coding_peer") {
    boosts++;
  }
  if (li.communityOutcome && disputeType !== "coverage_corroboration") boosts++;
  if (li.siblingCodes && li.siblingCodes.length > 0) boosts++;
  for (let i = 0; i < boosts; i++) {
    terms.push(weights.probativeTier.statistical * weights.categoryWeight.boost);
  }

  // Benchmark term — community / Medicare pricing benchmark.
  if (li.pricingBenchmark && disputeType !== "benchmark") {
    terms.push(
      weights.probativeTier.statistical * weights.categoryWeight.benchmark,
    );
  }

  const score = Math.min(
    1,
    terms.reduce((a, b) => a + b, 0),
  );
  return {
    lineItemId: li.lineItemId,
    disputeType,
    citeGradeTier,
    dollarAtStake,
    score,
    band: bandForScore(score, thresholds),
    spinePresent,
  };
}

// ============================================================================
// Axis (c) — readiness (MVDL §1b)
// ============================================================================

/** Optional "make it stronger" gap kinds (drive the readiness rail). */
const OPTIONAL_GAP_KINDS = new Set<string>([
  "cite_grade_incomplete",
  "same_plan_unconfirmed",
  "bound_canonical_coverage_thin",
  "plan_document_incomplete",
  "plan_document_missing",
  // Block C2 — confirming a parsed provider address is an optional strengthener,
  // not a required floor (the address is already present, so MVDL #3 is met).
  "provider_address_confirm",
]);

/** Recipient-address gap kinds (a missing recipient fails MVDL #3). */
const ADDRESS_GAP_KINDS = new Set<string>([
  "provider_address_missing",
  "insurer_address_missing",
]);

/**
 * The readiness RUNG, from the floor plus the open optional strengtheners.
 *
 * S302 — exported so the CLIENT can re-derive it after optimistically applying
 * a floor item it just wrote (patient identity, today), instead of waiting on a
 * full server reconcile before the pill and the send gate move. One rule, two
 * callers: the alternative was a second copy of this ternary in the browser,
 * which is how the two readiness ladders diverged in the first place.
 */
export function deriveReadinessState(
  mvdlMet: boolean,
  optionalOpen: readonly string[],
): ReadinessState {
  if (!mvdlMet) return "attention";
  return optionalOpen.length === 0 ? "airtight" : "ready_to_send";
}

export interface ReadinessResult {
  state: ReadinessState;
  mvdlMet: boolean;
  required: {
    dataTrustPass: boolean;
    backedClaim: boolean;
    recipientAddress: boolean;
    patientIdentity: boolean;
  };
  requiredMet: number;
  requiredTotal: number;
  /** Who the letter is addressed to — drives the recipientAddress label + which
   *  address(es) the floor requires (§1b #3). Defaults to `both` (legacy). */
  recipientKind: RecipientKind;
  /** Open optional ("make it stronger") gap kinds present on the dispute. */
  optionalOpen: string[];
}

// ============================================================================
// Top-level result + entry point
// ============================================================================

export interface StrengthResult {
  dataTrust: DataTrustState;
  evidenceStrength: {
    band: EvidenceBand;
    /**
     * Internal money-weighted score in [0,1]. NOT a probability of winning
     * (legal L1) — surfaced for calibration/telemetry only; the band is the
     * sole public surface.
     */
    score: number;
    totalDollarAtStake: number;
    perLine: PerLineScore[];
  };
  readiness: ReadinessResult;
}

export interface ComputeStrengthOptions {
  /** Tunable weights + thresholds (from `dispute_strength_config`); defaults to §1e. */
  config?: StrengthConfig;
  /**
   * Whether the patient name-match is resolved. undefined/false → treated as an
   * open MVDL item (conservative). The [disputeId] route passes
   * `!patientNameMismatch`; first-draft generate calls leave it undefined. The
   * patient-identity resolve affordance is built in Block C, so this stays open
   * on most Block A paths by design.
   */
  patientIdentityResolved?: boolean;
  /**
   * Who the letter is addressed to. Scopes the MVDL #3 recipient-address floor
   * to the address(es) the letter actually prints: `insurer` requires only the
   * insurer appeals address; `provider` only the provider billing address;
   * `both`/undefined → either-missing fails (conservative legacy default). The
   * routes derive this from the resolved letter type via `letterRecipientKind`.
   */
  recipientKind?: RecipientKind;
  /**
   * S301 `letter_requirements_v1`. OFF reproduces the pre-S301 mapping exactly,
   * including `collector` falling to the both-addresses branch. ON scopes the
   * floor to the ONE address this recipient prints — which is what makes a
   * debt-validation letter stop being marked "Not ready to send" for a missing
   * provider address it never mails to.
   *
   * ⚠ REQUIRED. As an optional field it shipped with ZERO call sites passing it,
   * so the floor silently kept the legacy mapping and the readiness tier never
   * moved (Andrew, S301 E2E). Every caller must now state its flag state.
   */
  letterRequirementsOn: boolean;
}

/**
 * Compute the three-axis dispute strength. Pure, never throws: malformed or
 * absent evidence yields the conservative floor (data-trust pass, evidence
 * `needs_support`, readiness `attention`).
 */
export function computeDisputeStrength(
  evidence: DisputeEvidence | null | undefined,
  opts?: ComputeStrengthOptions,
): StrengthResult {
  const { weights, thresholds } = opts?.config ?? DEFAULT_STRENGTH_CONFIG;

  // Axis (a) — data trust.
  const dataTrust = evaluateDataTrust(evidence);

  // Axis (b) — evidence strength (money-weighted per line).
  const lines = (evidence?.claims ?? []).flatMap((c) => c.lineItemEvidence ?? []);
  const perLine = lines.map((li) => scoreLine(li, weights, thresholds));
  const totalDollarAtStake = perLine.reduce((s, p) => s + p.dollarAtStake, 0);

  // Money-weighted aggregate. Σw_i = 0 (no dollars at stake / empty letter) →
  // score stays 0 → 'needs_support' per §1e (never default to well_supported).
  let score = 0;
  if (totalDollarAtStake > 0) {
    score =
      perLine.reduce((s, p) => s + p.dollarAtStake * p.score, 0) /
      totalDollarAtStake;
  }
  const band: EvidenceBand = bandForScore(score, thresholds);

  // Axis (c) — readiness (MVDL §1b).
  const gapKinds = new Set((evidence?.gaps ?? []).map((g) => g.kind as string));
  // §1b #2 — backed = cite-grade plan quote OR statute-backed hook OR EOB
  // allowed-amount. Statute-backed counts; binding is NOT required (§2).
  const anyBackedClaim =
    lines.some((li) => !!li.planBenefit) ||
    lines.some((li) => li.insurancePaid != null) ||
    (evidence?.legalBasis?.length ?? 0) > 0;
  // §1b #3 — require only the address(es) the letter actually prints. An
  // insurer appeal isn't blocked by a missing provider address (and vice-versa);
  // the non-recipient address stays an optional "strengthen" item, not a floor.
  // `both`/undefined → either-missing fails (conservative legacy behavior).
  const recipientKind: RecipientKind = opts?.recipientKind ?? "both";
  // S301 — under `letter_requirements_v1` the required address comes from the
  // SAME helper that decides what the panel asks for, so the address we score is
  // always the address the letter prints. "both" (legacy/undefined caller) keeps
  // the conservative either-missing-fails behavior.
  const requiredAddressGaps =
    opts?.letterRequirementsOn && recipientKind !== "both"
      ? [recipientAddressGapKindFor(recipientKind)]
      : recipientKind === "insurer"
        ? ["insurer_address_missing"]
        : recipientKind === "provider"
          ? ["provider_address_missing"]
          : Array.from(ADDRESS_GAP_KINDS);
  const recipientAddress = !requiredAddressGaps.some((k) => gapKinds.has(k));
  const required = {
    dataTrustPass: dataTrust.gate !== "hard_stop",
    backedClaim: anyBackedClaim,
    recipientAddress,
    patientIdentity: opts?.patientIdentityResolved === true,
  };
  const requiredVals = Object.values(required);
  const requiredMet = requiredVals.filter(Boolean).length;
  const requiredTotal = requiredVals.length;
  const mvdlMet = requiredMet === requiredTotal;
  const optionalOpen = Array.from(gapKinds).filter((k) =>
    OPTIONAL_GAP_KINDS.has(k),
  );
  const state: ReadinessState = deriveReadinessState(mvdlMet, optionalOpen);

  return {
    dataTrust,
    evidenceStrength: { band, score, totalDollarAtStake, perLine },
    readiness: {
      state,
      mvdlMet,
      required,
      requiredMet,
      requiredTotal,
      recipientKind,
      optionalOpen,
    },
  };
}

// ============================================================================
// Config loading (G6 tunability) — mirrors candidate_suggestions_config pattern
// ============================================================================

/** Read a finite number at a nested path; fall back to the §1e default. */
function pickNum(raw: unknown, path: string[], fallback: number): number {
  let cur: unknown = raw;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return fallback;
    }
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : fallback;
}

/** Parse a `dispute_strength_config.config` JSONB blob with per-field fallback
 *  to the §1e code defaults (a missing row / partial config never weakens the
 *  model). Exported for fixture coverage. */
export function parseStrengthConfig(raw: unknown): StrengthConfig {
  const D = DEFAULT_STRENGTH_WEIGHTS;
  const T = DEFAULT_STRENGTH_THRESHOLDS;
  return {
    weights: {
      probativeTier: {
        documentary: pickNum(raw, ["weights", "probativeTier", "documentary"], D.probativeTier.documentary),
        statistical: pickNum(raw, ["weights", "probativeTier", "statistical"], D.probativeTier.statistical),
        inferred: pickNum(raw, ["weights", "probativeTier", "inferred"], D.probativeTier.inferred),
      },
      citeGradeFactor: {
        verbatim: pickNum(raw, ["weights", "citeGradeFactor", "verbatim"], D.citeGradeFactor.verbatim),
        header: pickNum(raw, ["weights", "citeGradeFactor", "header"], D.citeGradeFactor.header),
        statute: pickNum(raw, ["weights", "citeGradeFactor", "statute"], D.citeGradeFactor.statute),
      },
      categoryWeight: {
        spine: pickNum(raw, ["weights", "categoryWeight", "spine"], D.categoryWeight.spine),
        boost: pickNum(raw, ["weights", "categoryWeight", "boost"], D.categoryWeight.boost),
        benchmark: pickNum(raw, ["weights", "categoryWeight", "benchmark"], D.categoryWeight.benchmark),
      },
    },
    thresholds: {
      partiallySupported: pickNum(raw, ["thresholds", "partiallySupported"], T.partiallySupported),
      wellSupported: pickNum(raw, ["thresholds", "wellSupported"], T.wellSupported),
    },
  };
}

/**
 * Load tunable weights + thresholds from the `dispute_strength_config` flag
 * (mig 134, default ON). Reads the row's config JSONB regardless of enabled
 * state (config flags carry tuning, not a gate). Any failure falls back to the
 * §1e code defaults — strength computation is never blocked by config I/O.
 */
export async function loadStrengthConfig(
  supabase: SupabaseClient,
): Promise<StrengthConfig> {
  try {
    const { data } = await supabase
      .from("feature_flag_rules")
      .select("config")
      .eq("flag_key", "dispute_strength_config")
      .maybeSingle();
    return parseStrengthConfig(data?.config ?? null);
  } catch {
    return DEFAULT_STRENGTH_CONFIG;
  }
}
