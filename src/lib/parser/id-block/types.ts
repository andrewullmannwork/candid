/**
 * ID-Block — corroboration source-independence: shared input/output contracts for
 * the pure cluster-legitimacy scorer (cluster-legitimacy.ts) and the content
 * fingerprint (content-fingerprint.ts).
 *
 * These types are the PR1 (units ①+②) seam. PR2's IO wrapper (an extension of
 * gatherLayer3Inputs) fills `ClusterMember[]` from the DB and calls the pure
 * scorer; the live promotion-gate hook then acts on the result. Keeping the
 * contract here lets the pure math be fixture-locked (Ship Gate G4) BEFORE it ever
 * touches the live CF-40 Layer-3 promotion path.
 *
 * SoT: plans/id-block-corroboration-source-independence.md §3 + §9.1.
 */

/**
 * Per-corroborating-user legitimacy signals, weighted by COST-TO-FAKE (§3.2). All
 * sourced from existing schema (§9.1) — the one missing signal (login /
 * distinct-active-days) is DEFERRED, not fabricated (auth is Firebase; no Supabase
 * session table). The costly high-weight signals carry the formula.
 */
export interface UserLegitimacySignals {
  /** users.id (UUID) — for the §4.1 admin breakdown + dedup. */
  userId: string;

  // ── High weight (each needs a real, costly artifact per account) ──
  /** ≥1 claim whose source document is an EOB (claims.source_document_id → documents.classified_type='eob'). */
  hasClaimsWithEob: boolean;
  /** stripe_customers.subscription_status ∈ {active, trialing} (payment on file). */
  hasActiveSubscription: boolean;
  /** ≥1 documents row with classified_type='insurance_card'. */
  hasInsuranceCard: boolean;

  // ── Medium weight (a "life" behind the account; expensive to fake at scale) ──
  /** days since users.created_at at evaluation time. */
  accountAgeDays: number;
  /** days from users.created_at to this corroborating upload (insurance_plans.created_at). */
  signupToUploadLatencyDays: number;
  /** count of distinct meaningful actions (varied-type documents + disputes + plan analyses). */
  activityBreadth: number;

  // ── Low weight (cheap to auto-fill — supporting, not decisive) ──
  /** profile completeness in [0,1] (users.display_name + profiles.* + insurance_plans.employer_name). */
  profileCompleteness: number;
}

/** One corroborating member of a promotion cluster (a user voting the winning value-tuple). */
export interface ClusterMember {
  signals: UserLegitimacySignals;
  /** documents.content_fingerprint (16-char hex) of this member's upload; null if absent. */
  contentFingerprint: string | null;
  /** ISO timestamp of the corroborating upload (insurance_plans.created_at). */
  uploadedAt: string;
  /** ISO timestamp of the account (users.created_at) — for signup-time correlation. */
  accountCreatedAt: string;
}

/** Cluster-level context the per-member signals don't carry. */
export interface ClusterContext {
  /**
   * TRUE when the canonical value under promotion has NO authoritative seed (not in
   * CMS / the cold-start corpus) — the highest-risk case, nothing to outvote a flood
   * (§3.6). A low-legitimacy NOVEL cluster is an independent flag trigger even when
   * the documents are NOT same-content.
   */
  isNovelCanonical: boolean;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export interface UserLegitimacyResult {
  /** composite legitimacy in [0,1]. */
  score: number;
  /** the three weighted band sub-scores (each in [0,1]) for the admin breakdown. */
  bands: { high: number; medium: number; low: number };
  /** per-signal contribution to `score` (sums to `score`) — §4.1 "which signal added what". */
  contributions: Record<string, number>;
}

export interface ClusterShapeResult {
  /** median per-user legitimacy (robust to one planted high-legitimacy account). */
  medianScore: number;
  /** every member's score is below the thin threshold — the core attack signature. */
  uniformlyThin: boolean;
  /** all corroborating uploads fall within the burst window (temporally clustered). */
  temporalBurst: boolean;
  /** all member accounts were created within the signup-correlation window. */
  signupCorrelated: boolean;
}

export interface ClusterLegitimacyResult {
  /** the gate value — median per-user legitimacy (§3.3: judge the SHAPE, not one user). */
  clusterScore: number;
  shape: ClusterShapeResult;
  /** ≥ majority of fingerprinted members are near-duplicate (same document replayed). */
  sameContent: boolean;
  /** passthrough of ClusterContext.isNovelCanonical. */
  novelCanonical: boolean;

  // ── Two independent flag triggers (pure, threshold-aware) ──
  /** §3.4 — same document AND cluster legitimacy below bar. */
  sameContentReplay: boolean;
  /** §3.6 — novel canonical AND cluster legitimacy below bar. */
  novelLowLegitimacy: boolean;
  /** would the gate flag this promotion? (the OR of the two triggers). */
  wouldFlag: boolean;

  /** human-readable trigger reasons for the admin work-list + Slack. */
  reasons: string[];
}
