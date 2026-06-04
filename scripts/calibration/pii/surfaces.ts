/**
 * Ing-E Phase 1 — canonical free-text surface classification (single source of
 * truth for both surface-inventory.ts and pii-audit.ts).
 *
 * "Canonical / cross-user" = stores whose free text is visible ACROSS users
 * (where Pattern 1 #9 originator-anonymity bites). User-owner-scoped stores
 * (insurance_plans / plan_covered_services / claim_line_items) are OUT of scope
 * (Pattern 1 #5) and deliberately absent here.
 *
 * The full list below is the RESULT of the schema-driven completeness pass
 * (surface-inventory.ts) — the hand-enumeration of 5+5 surfaces missed ~15 more
 * (raw_coverage_data, provider_descriptions, description_examples, context_extract,
 * the *_extracted_values / candidate_* blobs, …). Every cross-user TEXT/JSONB
 * column is now SWEPT, FLAGGED (fast-follow), or KNOWN_STRUCTURED (excluded) so the
 * inventory converges to zero unclassified free-text.
 *
 * Tier 1 = permanent canonical corroboration stores (PRIMARY launch gate).
 * Tier 2 = admin-visible review queues / insurer-appeal stores.
 * Tier 3 = telemetry/decision logs (flagged; not swept this pass — fast-follow).
 */

export type SurfaceKind =
  | "jsonb_provenance_sources_excerpt" // field_provenance.<field>.sources[].excerpt (+document_ref)
  | "jsonb_array_field" // a JSONB array column; each element has a free-text key
  | "text_column" // a plain TEXT column
  | "jsonb_blob"; // arbitrary JSONB — stringify the blob and scan

export interface CanonicalSurface {
  id: string;
  table: string;
  column: string;
  kind: SurfaceKind;
  arrayField?: string; // for jsonb_array_field: the per-element text key
  tier: 1 | 2 | 3;
  visibility: "canonical_cross_user" | "admin_queue" | "telemetry";
  sweep: boolean; // true = swept this pass; false = flagged fast-follow
  notes: string;
}

export const CANONICAL_SURFACES: readonly CanonicalSurface[] = [
  // ───────────────────────── Tier 1 — primary launch gate ─────────────────────
  // The verbatim-excerpt corroboration stores (copied cross-user by apply_promotion_event / apply_corrector_upsert):
  { id: "canonical_plans.field_provenance", table: "canonical_plans", column: "field_provenance", kind: "jsonb_provenance_sources_excerpt", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Plan-identity sources[].excerpt (service_slug IS NULL path). NOT named by tracker." },
  { id: "canonical_plan_services.field_provenance", table: "canonical_plan_services", column: "field_provenance", kind: "jsonb_provenance_sources_excerpt", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Service cost-share sources[].excerpt. The one surface the tracker named." },
  { id: "billing_code_identity.corroborator_sources", table: "billing_code_identity", column: "corroborator_sources", kind: "jsonb_array_field", arrayField: "raw_description", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "BILL PII surface: line-item descriptions from bills." },
  { id: "billing_code_identity.description_examples", table: "billing_code_identity", column: "description_examples", kind: "text_column", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Example bill descriptions (2nd desc store on the identity table). [inventory find]" },
  { id: "canonical_haiku_extractions.source_excerpt", table: "canonical_haiku_extractions", column: "source_excerpt", kind: "text_column", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Verbatim ≤200ch; read by dispute evidence-resolver. NOT named by tracker." },
  { id: "canonical_haiku_extractions.extracted_value", table: "canonical_haiku_extractions", column: "extracted_value", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Extracted field value blob. [inventory find]" },
  { id: "billing_code_mappings.description_signature", table: "billing_code_mappings", column: "description_signature", kind: "text_column", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Normalized (lowercased) bill description — normalization is NOT de-PII. Thesaurus-adjacent." },
  { id: "billing_code_mappings.provider_descriptions", table: "billing_code_mappings", column: "provider_descriptions", kind: "text_column", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Raw provider/bill descriptions. [inventory find — HIGH]" },
  { id: "billing_code_identity.description_signature", table: "billing_code_identity", column: "description_signature", kind: "text_column", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Normalized bill desc on the identity table. [inventory find]" },
  { id: "canonical_plans.raw_coverage_data", table: "canonical_plans", column: "raw_coverage_data", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Raw parsed coverage blob. [inventory find — HIGH]" },
  { id: "canonical_plans.last_haiku_extracted_values", table: "canonical_plans", column: "last_haiku_extracted_values", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Raw last-Haiku extracted values. [inventory find]" },
  { id: "canonical_plan_services.coverage_rules", table: "canonical_plan_services", column: "coverage_rules", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Coverage-rules JSONB. [inventory find]" },
  { id: "canonical_document_stability.last_haiku_extracted_values", table: "canonical_document_stability", column: "last_haiku_extracted_values", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "CF-40 v3 stability extracted values. [inventory find]" },
  { id: "canonical_document_stability.candidate_values", table: "canonical_document_stability", column: "candidate_values", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Candidate extracted values. [inventory find]" },
  { id: "canonical_document_stability.candidate_slots", table: "canonical_document_stability", column: "candidate_slots", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Multi-slot candidate values. [inventory find]" },
  { id: "canonical_field_corroboration.extracted_value_jsonb", table: "canonical_field_corroboration", column: "extracted_value_jsonb", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Corroboration extracted value. [inventory find]" },
  { id: "canonical_divergence_review.minority_value_jsonb", table: "canonical_divergence_review", column: "minority_value_jsonb", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Minority (dropped) extracted value. [inventory find]" },
  { id: "canonical_correction_challenges.proposed_value", table: "canonical_correction_challenges", column: "proposed_value", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Challenge proposed value. [inventory find]" },
  { id: "concepts.metadata", table: "concepts", column: "metadata", kind: "jsonb_blob", tier: 1, visibility: "canonical_cross_user", sweep: true, notes: "Concept metadata blob (raw text may land here per CLAUDE.md). [inventory find]" },

  // ───────────── Tier 2 — admin queues / insurer-appeal stores (measure now) ────
  { id: "concept_admin_review_queue.source_excerpt", table: "concept_admin_review_queue", column: "source_excerpt", kind: "text_column", tier: 2, visibility: "admin_queue", sweep: true, notes: "≤200ch verbatim (mig 061)." },
  { id: "concept_admin_review_queue.context_extract", table: "concept_admin_review_queue", column: "context_extract", kind: "text_column", tier: 2, visibility: "admin_queue", sweep: true, notes: "Doc context excerpt. [inventory find]" },
  { id: "service_catalog_admin_review_queue.source_excerpt", table: "service_catalog_admin_review_queue", column: "source_excerpt", kind: "text_column", tier: 2, visibility: "admin_queue", sweep: true, notes: "≤200ch verbatim (mig 065)." },
  { id: "service_catalog_admin_review_queue.context_extract", table: "service_catalog_admin_review_queue", column: "context_extract", kind: "text_column", tier: 2, visibility: "admin_queue", sweep: true, notes: "Doc context excerpt. [inventory find]" },
  { id: "service_catalog_admin_review_queue.candidate_suggestions", table: "service_catalog_admin_review_queue", column: "candidate_suggestions", kind: "jsonb_blob", tier: 2, visibility: "admin_queue", sweep: true, notes: "Candidate suggestions JSONB (mig 127)." },
  { id: "insurer_appeals_proposed_changes.source_excerpt", table: "insurer_appeals_proposed_changes", column: "source_excerpt", kind: "text_column", tier: 2, visibility: "admin_queue", sweep: true, notes: "Proposed-change verbatim (mig 051)." },
  { id: "insurer_appeals_proposed_changes.current_values", table: "insurer_appeals_proposed_changes", column: "current_values", kind: "jsonb_blob", tier: 2, visibility: "admin_queue", sweep: true, notes: "Current insurer values (addresses etc.). [inventory find]" },
  { id: "insurer_appeals_proposed_changes.proposed_values", table: "insurer_appeals_proposed_changes", column: "proposed_values", kind: "jsonb_blob", tier: 2, visibility: "admin_queue", sweep: true, notes: "Proposed insurer values. S151 test-pollution lived here. [inventory find]" },
  { id: "insurer_appeals_confirmations.metadata", table: "insurer_appeals_confirmations", column: "metadata", kind: "jsonb_blob", tier: 2, visibility: "admin_queue", sweep: true, notes: "Confirmation metadata. [inventory find]" },
  { id: "bill_parser_decisions.metadata", table: "bill_parser_decisions", column: "metadata", kind: "jsonb_blob", tier: 2, visibility: "admin_queue", sweep: true, notes: "May include raw Haiku response excerpt (mig 133)." },
  { id: "billing_code_plan_outcomes.common_denial_reasons", table: "billing_code_plan_outcomes", column: "common_denial_reasons", kind: "text_column", tier: 2, visibility: "canonical_cross_user", sweep: true, notes: "Denial-reason text (aggregate). [inventory find]" },

  // ───────────────── Tier 3 — flagged fast-follow (NOT swept this pass) ─────────
  // Admin/system-AUTHORED notes + section-name hints (not parsed-document PII), + telemetry.
  { id: "insurer_appeals_proposed_changes.admin_notes", table: "insurer_appeals_proposed_changes", column: "admin_notes", kind: "text_column", tier: 3, visibility: "admin_queue", sweep: false, notes: "Admin-authored note (not parsed PII)." },
  { id: "concept_admin_review_queue.admin_notes", table: "concept_admin_review_queue", column: "admin_notes", kind: "text_column", tier: 3, visibility: "admin_queue", sweep: false, notes: "Admin-authored note." },
  { id: "concept_admin_review_queue.source_section_hint", table: "concept_admin_review_queue", column: "source_section_hint", kind: "text_column", tier: 3, visibility: "admin_queue", sweep: false, notes: "Section-name hint (low PII risk)." },
  { id: "service_catalog_admin_review_queue.source_section_hint", table: "service_catalog_admin_review_queue", column: "source_section_hint", kind: "text_column", tier: 3, visibility: "admin_queue", sweep: false, notes: "Section-name hint." },
  { id: "service_catalog_admin_review_queue.rejection_reason", table: "service_catalog_admin_review_queue", column: "rejection_reason", kind: "text_column", tier: 3, visibility: "admin_queue", sweep: false, notes: "Admin rejection reason." },
  { id: "canonical_correction_challenges.sanity_check_notes", table: "canonical_correction_challenges", column: "sanity_check_notes", kind: "text_column", tier: 3, visibility: "canonical_cross_user", sweep: false, notes: "System/admin sanity-check note." },
  { id: "canonical_haiku_extractions.source_section_hint", table: "canonical_haiku_extractions", column: "source_section_hint", kind: "text_column", tier: 3, visibility: "canonical_cross_user", sweep: false, notes: "Section-name hint." },
  { id: "code_identity_admin_review_queue.admin_notes", table: "code_identity_admin_review_queue", column: "admin_notes", kind: "text_column", tier: 3, visibility: "admin_queue", sweep: false, notes: "Admin-authored note." },
  { id: "parse_audit_runs", table: "parse_audit_runs", column: "*", kind: "jsonb_blob", tier: 3, visibility: "telemetry", sweep: false, notes: "Fixture-only telemetry per S136; verify PROD rows + exact column before sweeping." },
  { id: "canonical_match_decisions.metadata", table: "canonical_match_decisions", column: "metadata", kind: "jsonb_blob", tier: 3, visibility: "telemetry", sweep: false, notes: "Decision-log metadata." },
];

/**
 * Benign cross-user TEXT/JSONB columns explicitly EXCLUDED from the PII surface —
 * enums, hashes, slugs, codes, status flags. Listed so the inventory completeness
 * check converges to zero unclassified free-text (each was reviewed, not ignored).
 */
export const KNOWN_STRUCTURED_EXCLUSIONS: readonly string[] = [
  "canonical_plan_services.source", // source enum ('sbc_parser' etc.)
  "billing_code_mappings.source", // source enum
  "canonical_haiku_extractions.source_user_doc_hash", // hash
  "canonical_haiku_extractions.source_excerpt_verified", // P-8 status enum
  "concept_admin_review_queue.source_excerpt_verified", // enum
  "concept_admin_review_queue.source_excerpt_extraction_method", // enum
  "service_catalog_admin_review_queue.parser_source", // enum
  "service_catalog_admin_review_queue.source_excerpt_verified", // enum
  "service_catalog_admin_review_queue.source_excerpt_extraction_method", // enum
  "code_identity_admin_review_queue.candidate_slugs", // slugs (structured vocab)
];

/**
 * Table-name patterns constituting the "canonical / cross-user universe" for the
 * inventory completeness check. Any TEXT/JSONB column on a matching table that is
 * NOT in CANONICAL_SURFACES or KNOWN_STRUCTURED_EXCLUSIONS is reported as
 * UNCLASSIFIED — forcing review (auto-catches future additions like
 * service_synonyms mig 145).
 */
export const CROSS_USER_TABLE_PATTERNS: readonly RegExp[] = [
  /^canonical_/,
  /^billing_code_/,
  /^concept(s|_)/,
  /_admin_review_queue$/,
  /^insurer_appeals_/,
  /^service_(catalog|synonyms)/,
];

export const SWEPT_SURFACES = CANONICAL_SURFACES.filter((s) => s.sweep);
