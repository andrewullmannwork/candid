/**
 * CF-40 v4 (S73.5 D2b + D8) — 4-tier badge derivation + DecoratedValue backend
 * confidence decouple.
 *
 * Subplan §2.11 (Display Badging UI) + §2.12 (Backend Confidence decoupled).
 *
 * Visible badge tier mapping:
 *   User Verified                       — user uploaded; no Layer 2 stability + no Layer 3 promotion
 *   Community Verified                  — Layer 2 stability achieved on (canonical, hash); Layer 3 doc-type NOT promoted
 *   Community & Document Verified       — Layer 3 doc-type promotion HAS fired (≥1 doc-type); canonical-level not yet
 *   Verified                            — canonical fully promoted (SBC + (EOC OR plan_doc) all doc-type-promoted)
 *
 * Hidden + Public Data + Community (inherited from existing v4 vocabulary)
 * retained for non-uploaded / parser-failure / public-source states.
 *
 * Backend confidence decouples from visible badge per Q-S73.5-19 LOCK — claim
 * audit + dispute letter generation use backend_confidence; UI uses badgeLevel.
 */

export type BadgeLevel =
  | "user_verified"
  | "community_verified"
  | "community_and_document_verified"
  | "verified"
  | "community"
  | "public_data"
  | "hidden";

export type BackendConfidence =
  | "verified"
  | "provisional"
  | "user_cite_grade"
  | "user_no_cite"
  | "inherited"
  | "public_only";

export interface BadgeDeriveInput {
  /**
   * Canonical-level: TRUE when SBC + (EOC OR plan_doc) all doc-type-promoted.
   * Per Subplan §2.5.
   */
  canonicalFullyVerified: boolean;
  /** Any doc-type for this canonical has promoted in Layer 3. */
  anyDocTypePromoted: boolean;
  /** User uploaded a doc to this canonical (hash exists in canonical_document_stability). */
  userUploaded: boolean;
  /** User's uploaded (canonical, hash) reached Layer 2 stability. */
  userDocLayer2Stable: boolean;
  /** Existing v4 logic ran (caller can pass result for fallback rendering). */
  v4Fallback: BadgeLevel;
}

/**
 * Per Subplan §2.11 render pseudo-code.
 */
export function deriveBadgeLevel(input: BadgeDeriveInput): BadgeLevel {
  if (input.canonicalFullyVerified) return "verified";
  if (input.anyDocTypePromoted) return "community_and_document_verified";
  if (input.userUploaded && input.userDocLayer2Stable) return "community_verified";
  if (input.userUploaded) return "user_verified";
  // User has not uploaded — fall back to existing v4 logic (Community or
  // Public Data per source).
  return input.v4Fallback;
}

export interface BackendConfidenceInput {
  /** Layer 3 doc-type promoted for the doc-type that supplies this field. */
  doctypePromotedForFieldSource: boolean;
  /** Layer 2 stability achieved on the user's specific doc. */
  layer2Stable: boolean;
  /** Field has Pattern P-8 cite-grade extract from user's own doc. */
  userCiteGrade: boolean;
  /** User has a parse but lacks cite-grade source_excerpt. */
  userNoCite: boolean;
  /** source = canonical_inherited; user hasn't uploaded. */
  inherited: boolean;
  /** CMS / public dataset only. */
  publicOnly: boolean;
}

/**
 * Per Subplan §2.12 Rule B (LOCKed): backend_confidence='verified' for
 * doc-type-promoted fields EVEN WHEN visible badge shows "Community & Document
 * Verified". Backend logic (claim audit, dispute letter) uses backendConfidence;
 * UI uses badgeLevel.
 */
export function deriveBackendConfidence(input: BackendConfidenceInput): BackendConfidence {
  if (input.doctypePromotedForFieldSource) return "verified";
  if (input.layer2Stable) return "provisional";
  if (input.userCiteGrade) return "user_cite_grade";
  if (input.userNoCite) return "user_no_cite";
  if (input.inherited) return "inherited";
  if (input.publicOnly) return "public_only";
  return "inherited"; // safe fallback
}

/**
 * Human-readable badge label for rendering. UI components import from here so
 * the canonical text stays single-source.
 */
export const BADGE_LABEL: Readonly<Record<BadgeLevel, string>> = {
  user_verified: "User Verified",
  community_verified: "Community Verified",
  community_and_document_verified: "Community & Document Verified",
  verified: "Verified",
  community: "Community",
  public_data: "Public Data",
  hidden: "Hidden",
};
