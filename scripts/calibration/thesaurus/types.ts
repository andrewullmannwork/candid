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
    falsePositives: number;
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
