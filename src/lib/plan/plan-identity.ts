/**
 * Plan identity — "is this uploaded document the same plan the user already
 * has, or a different one?" (S291, Andrew E2E finding #4)
 *
 * WHY THIS EXISTS
 * `process-plan.ts` answered that question by comparing plan NAMES as text:
 * strip five words ("insurance|company|inc|corp|health plan"), lowercase, then
 * test substring containment either way. That was wrong in BOTH directions, and
 * one real account proved both on the same day:
 *
 *   • FALSE POSITIVE — a scanned card and an uploaded SBC that both resolved to
 *     canonical plan `353bdd94` (i.e. provably the same catalog plan) were
 *     flagged as a plan-name mismatch, because the strings read differently.
 *   • FALSE NEGATIVE — an upload resolving to canonical `1a201a32`, a genuinely
 *     DIFFERENT plan from the active `353bdd94`, was silently supplement-merged
 *     into the active plan, because the profile's `plan_name` was empty so the
 *     name comparison never ran.
 *
 * The false negative is the expensive one: a different plan's terms merge into
 * the user's plan and every later bill is audited against a blend of two.
 *
 * THE INSIGHT
 * We already resolve each parsed document against the plan catalog and store
 * the link. That link is the plan's passport number — we were comparing how the
 * name is SPELLED while holding it. Two rows pointing at the same catalog entry
 * are the same plan whatever their cover pages say; two pointing at different
 * entries are different plans however alike the names look.
 *
 * PRECEDENCE — strongest evidence first, weakest last, "ask" as the floor:
 *   1. same canonical plan (both links at/above the confidence floor) → SAME
 *   2. same HIOS id                                                   → SAME
 *   3. same group number AND same insurer                             → SAME
 *   4. different insurer family                                       → DIFFERENT
 *   5. different canonical plan (both links at/above the floor)       → DIFFERENT
 *   6. different plan name                                            → DIFFERENT
 *   7. anything else                                                  → UNCERTAIN (prompt)
 *
 * PURE + SYNCHRONOUS BY DESIGN. Insurer identity arrives as a pre-resolved
 * catalog id (`insurerCatalogId`) because `matchInsurerCatalog` is async and
 * hits the DB — callers resolve it once, then this stays testable with no
 * fixtures-of-a-database. When the id is absent we fall back to normalized name
 * comparison, which is why 'UHC' vs 'UnitedHealthcare Insurance Company' needs
 * the catalog id to be recognised as one company rather than two.
 *
 * CONFIDENCE FLOOR (Andrew, 0.85): a canonical link is itself a fuzzy match. A
 * wrong link would make rule 1 confidently suppress a prompt the user needed,
 * so links below the floor don't get to decide identity — they fall through to
 * the weaker rules, which can still reach "uncertain" and ask.
 */

import { insurerNamesSameFamily } from "@/lib/plan/insurer-match";

/** Default canonical-link confidence required before a link may decide identity. */
export const CANONICAL_IDENTITY_CONFIDENCE_FLOOR = 0.85;

export type PlanIdentityVerdict = "same" | "different" | "uncertain";

/** Why we decided — stable machine keys for telemetry and for prompt copy. */
export type PlanIdentityReason =
  | "canonical_match"
  | "plan_name_match"
  | "hios_match"
  | "group_and_insurer_match"
  | "insurer_differs"
  | "canonical_differs"
  | "plan_name_differs"
  | "insufficient_signal";

export interface PlanIdentityFacts {
  canonicalPlanId?: string | null;
  /** Confidence of THIS row's canonical link (0-1). Absent → treated as unknown. */
  canonicalConfidence?: number | null;
  hiosId?: string | null;
  groupNumber?: string | null;
  insurerName?: string | null;
  /** Pre-resolved `insurer_catalog.id` — the alias-aware identity. */
  insurerCatalogId?: string | null;
  planName?: string | null;
}

export interface PlanIdentityResult {
  verdict: PlanIdentityVerdict;
  reason: PlanIdentityReason;
  /** One plain sentence for the prompt — why we're asking (or why we didn't). */
  evidence: string;
}

/**
 * May an upload be merged into the plan it was compared against?
 *
 * ONLY `same`. Both `different` and `uncertain` hold the upload as an inactive
 * plan and ask the user — preserve-on-uncertainty. `uncertain` deliberately
 * behaves like `different` rather than like `same`: the cost of holding a plan
 * that turns out to be the user's is one prompt, while the cost of merging one
 * that isn't is a permanent blend of two policies that every later bill is then
 * audited against. The two errors are not symmetric, so the tie does not go to
 * the merge.
 *
 * Extracted as a named predicate rather than left inline at the call site so
 * the policy is stateable, testable, and visible in one place — the decision
 * that changes behaviour is worth more than one keystroke of indirection.
 *
 * Written as a TYPE PREDICATE so the policy also narrows: in the `else` branch
 * the verdict is provably `"different" | "uncertain"`, which is what lets the
 * held-plan payload declare that narrower type instead of re-asserting it. The
 * compiler now enforces that a `same` verdict can never reach the "we held your
 * upload and need you to confirm" path.
 */
export function identityAllowsMerge(verdict: PlanIdentityVerdict): verdict is "same" {
  return verdict === "same";
}

/**
 * Normalize a plan/insurer name for comparison. Deliberately conservative:
 * drops corporate suffixes, punctuation and the carrier prefix insurers put on
 * their own plan names, then collapses whitespace. It does NOT try to be clever
 * about abbreviations — that's the insurer catalog's job.
 */
export function normalizePlanText(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[.,'"()]/g, " ")
    .replace(/\b(insurance|assurance|company|companies|inc|incorporated|corp|corporation|llc|health\s*plans?|healthcare|health\s*care|of\s+[a-z]+)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const present = (s: string | null | undefined): s is string =>
  typeof s === "string" && s.trim().length > 0;

/** Canonical link is trustworthy enough to decide identity on its own. */
function canonicalUsable(f: PlanIdentityFacts, floor: number): boolean {
  if (!present(f.canonicalPlanId)) return false;
  // Absent confidence is treated as unknown, NOT as certain — an unscored link
  // must not silently outrank an explicit low score.
  return typeof f.canonicalConfidence === "number" && f.canonicalConfidence >= floor;
}

export function resolvePlanIdentity(
  existing: PlanIdentityFacts,
  parsed: PlanIdentityFacts,
  opts?: { canonicalConfidenceFloor?: number },
): PlanIdentityResult {
  const floor = opts?.canonicalConfidenceFloor ?? CANONICAL_IDENTITY_CONFIDENCE_FLOOR;
  const bothCanonical = canonicalUsable(existing, floor) && canonicalUsable(parsed, floor);

  // 1 — same catalog plan. Strongest signal; names are irrelevant against it.
  if (bothCanonical && existing.canonicalPlanId === parsed.canonicalPlanId) {
    return {
      verdict: "same",
      reason: "canonical_match",
      evidence: "Both resolve to the same plan in our catalog.",
    };
  }

  // 2 — same government plan id.
  if (present(existing.hiosId) && present(parsed.hiosId) && existing.hiosId.trim() === parsed.hiosId.trim()) {
    return { verdict: "same", reason: "hios_match", evidence: "Same plan ID." };
  }

  // 3 — same employer group AND same carrier. Group numbers are NOT unique
  // across insurers, so the insurer must corroborate or two unrelated employers
  // both using group "12345" would collide.
  const sameInsurerById =
    present(existing.insurerCatalogId) &&
    present(parsed.insurerCatalogId) &&
    existing.insurerCatalogId === parsed.insurerCatalogId;
  const insurerNamesKnown = present(existing.insurerName) && present(parsed.insurerName);
  const sameInsurerByName =
    insurerNamesKnown &&
    normalizePlanText(existing.insurerName) === normalizePlanText(parsed.insurerName);
  const sameInsurer = sameInsurerById || (!present(existing.insurerCatalogId) && !present(parsed.insurerCatalogId) && sameInsurerByName);

  if (
    present(existing.groupNumber) &&
    present(parsed.groupNumber) &&
    existing.groupNumber.trim() === parsed.groupNumber.trim() &&
    sameInsurer
  ) {
    return {
      verdict: "same",
      reason: "group_and_insurer_match",
      evidence: "Same insurer and same group number.",
    };
  }

  // 4 — different carrier. Decided by catalog id when both sides resolved one
  // (alias-aware: 'UHC' and 'UnitedHealthcare Insurance Company' are one id);
  // by normalized name only when neither side did.
  //
  // S292 FAMILY GUARD (the "Blue Cross" incident): the insurer catalog carries
  // one row per LEGAL ENTITY — dozens of Blue-Cross-family rows — and resolving
  // a bare brand name against them is order-dependent luck (matchInsurerCatalog
  // returns the first substring hit). So two ids that DIFFER do not prove two
  // carriers when the NAMES family-match ("Blue Cross" ⊂ "Blue Cross Blue
  // Shield of Wyoming"): fall through instead of asserting a carrier change.
  // This guard is rule 4's ONLY — rule 5 below still fires for same-family
  // different PLANS (both canonical links at/above the floor), and sides
  // without names keep the id verdict (no evidence is not agreement).
  if (present(existing.insurerCatalogId) && present(parsed.insurerCatalogId) && !sameInsurerById) {
    if (!insurerNamesSameFamily(existing.insurerName, parsed.insurerName)) {
      return {
        verdict: "different",
        reason: "insurer_differs",
        evidence: `This document is from ${parsed.insurerName || "a different insurer"}, not ${existing.insurerName || "your current insurer"}.`,
      };
    }
  }
  if (
    !present(existing.insurerCatalogId) &&
    !present(parsed.insurerCatalogId) &&
    insurerNamesKnown &&
    !sameInsurerByName
  ) {
    const a = normalizePlanText(existing.insurerName);
    const b = normalizePlanText(parsed.insurerName);
    // Containment guard: "cigna" vs "cigna florida" is not a carrier change.
    if (!a.includes(b) && !b.includes(a)) {
      return {
        verdict: "different",
        reason: "insurer_differs",
        evidence: `This document is from ${parsed.insurerName}, not ${existing.insurerName}.`,
      };
    }
  }

  // 5 — same carrier, different catalog plan. This is the case that used to
  // merge silently.
  if (bothCanonical && existing.canonicalPlanId !== parsed.canonicalPlanId) {
    return {
      verdict: "different",
      reason: "canonical_differs",
      evidence: "Same insurer, but a different plan ID — these are two separate policies.",
    };
  }

  // 6 — fall back to names.
  if (present(existing.planName) && present(parsed.planName)) {
    const a = normalizePlanText(existing.planName);
    const b = normalizePlanText(parsed.planName);
    if (a && b && a !== b && !a.includes(b) && !b.includes(a)) {
      return {
        verdict: "different",
        reason: "plan_name_differs",
        evidence: `Your plan on file is ${existing.planName}; this document is ${parsed.planName}.`,
      };
    }
    if (a && b) {
      // Names agree but nothing stronger corroborated it — good enough to merge,
      // but tagged distinctly so telemetry can tell a catalog-proven match from
      // a merely name-agreeing one.
      return { verdict: "same", reason: "plan_name_match", evidence: "Same plan name." };
    }
  }

  // 7 — not enough to decide. Ask; never guess (preserve-on-uncertainty).
  return {
    verdict: "uncertain",
    reason: "insufficient_signal",
    evidence: "We couldn't tell from the document whether this is the same plan.",
  };
}

/**
 * S292 Bug 2 — ASSEMBLY, not switching (the upload path's peer of
 * set-active-canonical's `assembly`).
 *
 * When the existing active plan is a mere STUB — a card scan or typed insurer
 * (source manual/insurance_card) with no plan name — an uploaded document from
 * the same carrier family is the OTHER HALF of one plan being built, not a
 * competing plan. Asking "which insurer is right?" there is a false question:
 * both strings describe the same carrier at different levels of legal
 * precision, and answering it cost a real user her card display.
 *
 * Call-site policy, deliberately NOT inside `resolvePlanIdentity` — the
 * resolver answers "same plan or different?" from identity facts alone; what
 * to DO with a non-`same` verdict against a stub is the upload flow's call.
 * Pure and synchronous so the fixture can walk the whole decision table.
 *
 * Returns true (merge into the stub — the identityTargetPlan path, receipt and
 * all, no prompt) only when ALL hold:
 *   - the resolver did NOT prove a different catalog plan (`canonical_differs`
 *     outranks assembly: two links at/above the floor pointing at different
 *     canonical plans are two policies whatever the stub looks like);
 *   - the existing row is a stub: source manual/insurance_card AND no plan
 *     name (a named plan is an established identity, not half a pair);
 *   - the stub has no insurer at all, OR its insurer family-matches the
 *     parsed document's ("Blue Cross" + "Blue Cross Blue Shield of Wyoming").
 *     A genuine cross-family divergence (card says Cigna, document says
 *     Aetna) still prompts — assembly never overrides a real carrier change.
 */
export const STUB_ASSEMBLY_REASON = "stub_assembly";

export function shouldAssembleStub(params: {
  reason: PlanIdentityReason;
  existingSource: string | null;
  existingPlanName: string | null;
  existingInsurerName: string | null;
  parsedInsurerName: string | null;
}): boolean {
  if (params.reason === "canonical_differs") return false;
  const isStub =
    (params.existingSource === "manual" || params.existingSource === "insurance_card") &&
    !present(params.existingPlanName);
  if (!isStub) return false;
  return (
    !present(params.existingInsurerName) ||
    insurerNamesSameFamily(params.existingInsurerName, params.parsedInsurerName)
  );
}
