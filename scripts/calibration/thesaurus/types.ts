/**
 * Service Thesaurus calibration harness — shared types.
 *
 * Scoring is DETERMINISTIC over frozen snapshots (no DB, no Haiku in score.ts).
 * The snapshots that COST Haiku (the resolver forward pass) are produced by
 * resolve-snapshot.ts — the Sonnet/separate-session step — and frozen to JSON.
 *
 * Metric design (per service_thesaurus.md §7, refined S162 critical pass):
 *  - FORWARD metrics (resolver run on GT) move every phase 1-4. STORED metrics
 *    (current canonical_plan_services / live /compare) move at Phase 5 backfill.
 *  - B2 precision uses ONLY adjudicationStatus==="andrew" entries (independent
 *    ground truth) — auto/resolver-proposed entries are circular for precision.
 *  - S3 zero-regression needs the per-service mapping SNAPSHOT, not just scores.
 */

export type DocType = "sbc" | "eoc" | "plan_document";
export type ResolutionSource = "code_cache" | "signature_cache" | "trigram_exact" | "haiku" | "none";

/** One human-identifiable source service in a GT document, with its adjudicated truth. */
export interface GtService {
  /** Stable id, unique across the GT corpus (e.g. `${docId}#${idx}`). */
  id: string;
  docId: string;
  insurer: string;
  docType: DocType;
  planYear: number | null;
  /** Canonical this doc corresponds to (for B1-stored lookup); null if doc not yet in the canonical corpus. */
  canonicalPlanId: string | null;
  serviceName: string;
  bindingExcerpt?: string;
  /** Adjudicated correct slug; null === genuinely untracked (NO_CONCEPT → resolver should NOT map it). */
  correctSlug: string | null;
  /**
   * S169: human-adjudicated ADDITIONAL-correct slugs for a genuinely ambiguous service (e.g. an
   * eye-specialist visit is correct as either `specialist_visit` or `medical_eye_care`). The resolver
   * scores correct on correctSlug OR any acceptableSlug (rename-aware). Andrew-adjudicated ONLY —
   * distinct from `proposedAlternatives` (resolver-proposed = circular; never feeds scoring).
   */
  acceptableSlugs?: string[];
  /** Independence gate: only "andrew" entries count toward B2 precision. */
  adjudicationStatus: "auto" | "andrew";
  /** Distinctness probe — the partner service(s) this must NOT collapse into (co-occurrence veto, §5). */
  isNegativePair?: boolean;
  /** id(s) of the GtService(s) this negative pair must resolve DIFFERENTLY from. */
  negativePartnerIds?: string[];
  /** GT-fidelity flag (binding excerpt not locatable) — excluded from all scoring, reported separately. */
  notFound?: boolean;
  /** Other catalog slugs the proposer weighed (multi-slug ambiguity context for the worksheet). */
  proposedAlternatives?: string[];
  /** Why this entry needs Andrew's eye: "multi_slug" | "no_concept". Drives the clustered worksheet. */
  trickyReason?: "multi_slug" | "no_concept";
  /** In/out cost-share strings (auditability + future Phase-2 co-occurrence veto inputs). */
  inCostShare?: string | null;
  outCostShare?: string | null;
}

/** Resolver output for one GT service in a given phase (the FORWARD mapping). */
export interface ForwardMapEntry {
  gtId: string;
  resolvedSlug: string | null;
  conceptId: string | null;
  confidence: number;
  source: ResolutionSource;
  needsReview: boolean;
  /**
   * S170 N-run majority: fraction of the N forward runs that agreed with the winning (canon'd) slug
   * for this gtId. 1.0 = unanimous; undefined on a legacy single-run snapshot. The de-noising signal.
   */
  agreement?: number;
}

/**
 * S170 N-run majority convergence summary — written by resolve-snapshot.ts, printed by run.ts.
 * The gate's stability statement: proves the majority is stable (or surfaces the flippy entries).
 * Computed over ALL scored entries and the andrew-B2 subset separately.
 */
export interface ConvergenceReport {
  nRuns: number;
  /** votes-for-winner (1..N) -> count of gtIds. */
  histogramAll: Record<number, number>;
  histogramAndrew: Record<number, number>;
  /** entries with ANY disagreement (agreement < 1). */
  unstableAll: number;
  unstableAndrew: number;
  /** entries decided by a single vote (winner − runner-up ≤ 1) — the fragile gate cases. */
  fragileAll: number;
  fragileAndrew: number;
  /** entries whose winner was a count-tie resolved by confidence/lex. */
  tieBroken: number;
  meanAgreementAll: number;
  meanAgreementAndrew: number;
  /** sample of fragile andrew entries for eyeballing (winner + full vote tally). */
  fragileAndrewSample: { gtId: string; serviceName: string; winner: string | null; votes: Record<string, number> }[];
}

/** Stored canonical coverage (service_slug rows) for one canonical plan. */
export interface StoredCanonical {
  canonicalPlanId: string;
  slugs: string[];
}

/** A 3-plan compare cohort snapshot (from the REAL resolveCanonicalPlan over the cohort). */
export interface CohortSnapshot {
  cohortId: string;
  plans: {
    canonicalPlanId: string;
    planName: string;
    insurer: string;
    /** slugs the plan has a real CompareBenefit for. */
    coveredSlugs: string[];
    /** slugs synthesized by the ACA/preventive backstop (empty at baseline-without-backstop). */
    inferredSlugs: string[];
  }[];
}

/** Per-slug inbound row count in canonical_plan_services (B5 over-collapse tripwire). */
export type B5Counts = Record<string, number>;

// ── Scorecard ───────────────────────────────────────────────────────────────

export interface RecallBreakdown {
  recall: number; // hits / denom (0 when denom 0)
  hits: number;
  denom: number;
}

export interface ScoreCard {
  phaseLabel: string;
  gtVersion: string;
  corpus: {
    totalGt: number;
    scored: number; // real-slug, not notFound, not negative-only
    noConcept: number;
    negativePairs: number;
    notFound: number;
    andrewAdjudicated: number;
    byDocType: Record<string, number>;
    byInsurer: Record<string, number>;
  };
  b1Forward: RecallBreakdown & {
    byDocType: Record<string, RecallBreakdown>;
    byInsurer: Record<string, RecallBreakdown>;
  };
  b1Stored: RecallBreakdown;
  b2Precision: {
    precision: number; // correct / mapped-andrew (the FLOOR — existing/unified mapping)
    correct: number;
    mappedAndrew: number; // andrew entries with a real correctSlug that the resolver mapped
    /** of NO_CONCEPT andrew entries, fraction the resolver wrongly mapped (over-mapping). */
    falsePositiveRate: number;
    falsePositives: number; // GENUINE over-mapping: no-concept -> existing/rename slug
    /** S168: no-concept -> NEW-VOCAB slug = intended News recovery, NOT a false positive (reported in threeWay). */
    falsePositivesNewVocab: number;
    noConceptAndrew: number;
    negativePairViolations: number;
    byDocType: Record<string, { precision: number; correct: number; mapped: number }>;
    byInsurer: Record<string, { precision: number; correct: number; mapped: number }>;
  };
  b3: {
    gapRateWithoutBackstop: number;
    gapRateWithBackstop: number;
    totalCells: number;
    unkWithout: number;
    unkWith: number;
    perCohort: { cohortId: string; cells: number; unkWithout: number; unkWith: number }[];
  };
  /** S3 zero-regression ledger vs the frozen baseline forward snapshot. */
  ledger: {
    regressions: LedgerEntry[]; // correct→incorrect — BLOCKS ship
    improvements: LedgerEntry[]; // incorrect/unmapped→correct
    newlyMapped: LedgerEntry[]; // unmapped→mapped (correctness noted)
    lost: LedgerEntry[]; // mapped→unmapped
    counts: { regressions: number; improvements: number; newlyMapped: number; lost: number };
  };
  /** G-junk-4 over-collapse: slugs whose inbound count spiked vs baseline B5. */
  overCollapse: { slug: string; baseline: number; current: number; deltaPct: number }[];
  /**
   * S168 after-score 3-way split (andrew-only; rename-aware via the derived rename map).
   *  (a) recovered  — before-wrong -> after-right (the structural fix recovered it)
   *  (b) stillWrong — after != correct (the Phase-2 synonym backlog)
   *  (c) newsRecover — no-concept -> NEW-VOCAB slug (reported APART; semi-circular — we minted those
   *                    slugs from the same classification, so this is coverage, NOT validated precision)
   */
  threeWay: {
    recovered: { count: number; sample: LedgerEntry[] };
    stillWrong: { count: number; sample: LedgerEntry[] };
    newsRecover: { count: number; bySlug: Record<string, { count: number; sampleNames: string[] }> };
  };
}

export interface LedgerEntry {
  gtId: string;
  serviceName: string;
  docId: string;
  insurer: string;
  baselineSlug: string | null;
  currentSlug: string | null;
  correctSlug: string | null;
}
