/**
 * Calibration progress tracker — types.
 *
 * Per S136 critical review + Andrew approval (2026-05-28):
 *   - Canonical metric: monotonic improvement of `fields_verifiable` per (state, doc)
 *   - Opus is REFERENCE data, not gold (disagreements flagged, not penalized)
 *   - Ground truth derived from cross-state consistency (Option E)
 *
 * S138 extension (PR2):
 *   - Multi-site axis added: plan_identity (existing) + sbc + plan_doc + code_identity
 *     + description_match + eoc. Each `CalibrationState` carries `parser_site`.
 *   - `canonical_fields` and `doc_slugs` are per-site (declared in PARSER_SITE_REGISTRY).
 *   - Sites without Opus coverage rely on Haiku-comprehensive ceiling as sole GT source
 *     (`single_source` semantics already exist for plan-identity edge cases).
 *   - Vault layout per site: 'doc_keyed_with_prefix' (existing 5 SBC/EOC docs shared
 *     across plan_identity / sbc / plan_doc / eoc; site identified by file prefix)
 *     OR 'site_subdir' (code_identity + description_match have their own unit corpora).
 */

// ── Parser-site axis ────────────────────────────────────────────────────────

export const PARSER_SITES = [
  'plan_identity',
  'sbc',
  'plan_doc',
  'code_identity',
  'description_match',
  'eoc',
] as const;
export type ParserSite = (typeof PARSER_SITES)[number];

export interface ParserSiteConfig {
  site: ParserSite;
  label: string;
  description: string;
  /** Canonical field names emitted by this parser site (camelCase). */
  canonical_fields: readonly string[];
  /** Identifiers for the calibration units (doc slugs OR code identifiers OR description slots). */
  doc_slugs: readonly string[];
  /** State IDs used to derive ground truth (null when no such baseline exists for this site). */
  ground_truth_opus_state_id: string | null;
  ground_truth_haiku_ceiling_state_id: string | null;
  /** State ID that anchors monotonic-improvement deltas. */
  defect_floor_state_id: string;
  /**
   * Vault artifact layout:
   *   - 'doc_keyed_with_prefix': files live at `<doc-slug>/<prefix><artifact>.json`.
   *     Existing plan-identity layout uses prefix=''. SBC uses prefix='sbc-', etc.
   *   - 'site_subdir': files live at `<site-subdir>/<unit-id>/<artifact>.json`.
   *     Used when units are not shared with other sites (codes, descriptions).
   */
  vault_layout: 'doc_keyed_with_prefix' | 'site_subdir';
  vault_subdir_or_prefix: string;
}

// ── Plan-identity canonical fields (preserved from pre-PR2 harness) ─────────

export const CANONICAL_PLAN_IDENTITY_FIELDS = [
  'planName',
  'insurerName',
  'planYear',
  'planType',
  'networkType',
  'metalTier',
  'groupNumber',
  'deductibleIndividual',
  'deductibleFamily',
  'outDeductibleIndividual',
  'outDeductibleFamily',
  'oopMaxIndividual',
  'oopMaxFamily',
  'outOopMaxIndividual',
  'outOopMaxFamily',
  'isAcaCompliant',
  'acaComplianceBasis',
] as const;

/** Plan-identity calibration units (4 SBCs + 1 EOC). */
export const PLAN_IDENTITY_DOCS = [
  'oap-buy-up',
  'ambetter-bronze-ppo-ca',
  'gold-80-hmo',
  'anthem-in-17575IN0990006',
  'ecm-eoc',
] as const;

// ── SBC parser canonical fields ─────────────────────────────────────────────
//
// SBC parser extracts important_questions section via src/lib/sbc/haiku-prompts/
// important-questions.ts — same 17 plan-identity-scope fields as plan_doc's
// plan-identity prompt, but via a DIFFERENT system prompt and call path. PR2
// calibrates this so PR1's temp=0 flip can be validated against the SBC parser
// path, not only the plan_doc path.

export const SBC_PARSER_FIELDS = CANONICAL_PLAN_IDENTITY_FIELDS;

// ── plan_doc canonical fields ────────────────────────────────────────────────
//
// plan_doc parser has 3 sub-prompts beyond plan-identity. PR2 calibrates
// access_instructions section (deterministic scalars only).

export const PLAN_DOC_PARSER_FIELDS = [
  'customerServicePhone',
  'networkFinderUrl',
  // domainContacts is an object map; flattened to a single canonical field
  // representing presence-vs-absence (Pattern P-8 excerpt covers the whole block)
  'domainContactsPresent',
] as const;

// ── code_identity canonical fields ───────────────────────────────────────────
//
// code-identity.ts haikuNearestSignature scores semantic similarity between a
// proposed billing-code signature and existing candidates. Returns:
//   - best_match_signature: string | null
//   - similarity: 0..1
//   - reason: short text (excluded from scoring — free-text, not stable for monotonic check)
//
// PR2 scope: best_match_signature + similarity. 5 synthetic test cases spanning
// CPT/HCPCS/NDC/REV/DRG with known-correct expected match.

export const CODE_IDENTITY_FIELDS = [
  'bestMatchSignature',
  'similarity',
] as const;

export const CODE_IDENTITY_UNITS = [
  'cpt-99213',
  'hcpcs-J0129',
  'ndc-00310-7461-30',
  'rev-0250',
  'drg-470',
] as const;

// ── description_match canonical fields ──────────────────────────────────────
//
// claims/service-mapper.ts maps bill line item descriptions to fixed-enum service
// slugs. PR2 calibrates 5 representative descriptions in a single batched call
// (matches PROD batch-call pattern).

export const DESCRIPTION_MATCH_FIELDS = [
  'serviceSlug',
  'confidence',
] as const;

export const DESCRIPTION_MATCH_UNITS = [
  'desc-office-visit',
  'desc-lab-cbc',
  'desc-radiology-mri',
  'desc-emergency-room',
  'desc-physical-therapy',
] as const;

// ── EOC canonical fields ─────────────────────────────────────────────────────
//
// EOC parser has 8 sub-prompts. PR2 calibrates eligibility_rules section
// (deterministic scalars). Other sub-prompts deferred to follow-up PRs.

export const EOC_PARSER_FIELDS = [
  'effectiveDateRule',
  'dependentAgeLimit',
  'cobraEligible',
  'cobraMaxMonths',
  'specialEnrollmentEvents',
] as const;

/** EOC calibration unit — single doc (only ECM EOC in current corpus). */
export const EOC_DOCS = ['ecm-eoc'] as const;

// ── Parser site registry ────────────────────────────────────────────────────

export const PARSER_SITE_REGISTRY: Record<ParserSite, ParserSiteConfig> = {
  plan_identity: {
    site: 'plan_identity',
    label: 'Plan Identity (live PROD plan-identity prompt — 17 fields)',
    description:
      'Headline canonical-plan identification fields extracted by plan_doc/haiku-prompts/plan-identity.ts. Calibrated S136-S137 across 5 docs.',
    canonical_fields: CANONICAL_PLAN_IDENTITY_FIELDS,
    doc_slugs: PLAN_IDENTITY_DOCS,
    ground_truth_opus_state_id: 'opus-baseline-2026-05-28',
    ground_truth_haiku_ceiling_state_id: 'haiku-comprehensive-temp1-2026-05-28',
    defect_floor_state_id: 'haiku-live-prod-temp1-2026-05-28',
    vault_layout: 'doc_keyed_with_prefix',
    vault_subdir_or_prefix: '', // existing files at doc root with no prefix
  },
  sbc: {
    site: 'sbc',
    label: 'SBC parser (5 sections; deterministic-scalar fields beyond plan-identity)',
    description:
      'Fields extracted by src/lib/sbc/parser.ts and downstream voted-parser. Scope: deterministic scalars in important_questions / appeals_grievances / example_scenarios. List fields (services arrays) deferred.',
    canonical_fields: SBC_PARSER_FIELDS,
    doc_slugs: PLAN_IDENTITY_DOCS.filter((d) => d !== 'ecm-eoc'), // SBCs only (4 docs)
    ground_truth_opus_state_id: null,
    ground_truth_haiku_ceiling_state_id: 'sbc-haiku-ceiling-2026-05-28',
    defect_floor_state_id: 'sbc-haiku-defect-floor-2026-05-28',
    vault_layout: 'doc_keyed_with_prefix',
    vault_subdir_or_prefix: 'sbc-',
  },
  plan_doc: {
    site: 'plan_doc',
    label: 'plan_doc parser (access_instructions sub-prompt; deterministic scalars)',
    description:
      'Fields extracted by src/lib/plan_doc/haiku-prompts/access-instructions.ts. Scope: PCP/referrals/portal scalars. List fields deferred.',
    canonical_fields: PLAN_DOC_PARSER_FIELDS,
    doc_slugs: PLAN_IDENTITY_DOCS.filter((d) => d !== 'ecm-eoc'),
    ground_truth_opus_state_id: null,
    ground_truth_haiku_ceiling_state_id: 'plan-doc-haiku-ceiling-2026-05-28',
    defect_floor_state_id: 'plan-doc-haiku-defect-floor-2026-05-28',
    vault_layout: 'doc_keyed_with_prefix',
    vault_subdir_or_prefix: 'plan-doc-',
  },
  code_identity: {
    site: 'code_identity',
    label: 'code-identity (billing code → type + service slug)',
    description:
      'Fields extracted by src/lib/parser/code-identity.ts. 5 codes spanning CPT/HCPCS/NDC/REV/DRG.',
    canonical_fields: CODE_IDENTITY_FIELDS,
    doc_slugs: CODE_IDENTITY_UNITS,
    ground_truth_opus_state_id: null,
    ground_truth_haiku_ceiling_state_id: 'code-identity-haiku-ceiling-2026-05-28',
    defect_floor_state_id: 'code-identity-haiku-defect-floor-2026-05-28',
    vault_layout: 'site_subdir',
    vault_subdir_or_prefix: 'code-identity',
  },
  description_match: {
    site: 'description_match',
    label: 'description-match (bill line item description → service slug)',
    description:
      'Fields extracted by src/lib/claims/service-mapper.ts. 5 PROD bill descriptions spanning service types.',
    canonical_fields: DESCRIPTION_MATCH_FIELDS,
    doc_slugs: DESCRIPTION_MATCH_UNITS,
    ground_truth_opus_state_id: null,
    ground_truth_haiku_ceiling_state_id: 'description-match-haiku-ceiling-2026-05-28',
    defect_floor_state_id: 'description-match-haiku-defect-floor-2026-05-28',
    vault_layout: 'site_subdir',
    vault_subdir_or_prefix: 'description-match',
  },
  eoc: {
    site: 'eoc',
    label: 'EOC parser (8 sub-prompts; deterministic-scalar fields per section)',
    description:
      'Fields extracted across src/lib/eoc/haiku-prompts/*. Scope: scalars + flags per section. List fields (prior_auth code arrays) deferred.',
    canonical_fields: EOC_PARSER_FIELDS,
    doc_slugs: EOC_DOCS,
    ground_truth_opus_state_id: null,
    ground_truth_haiku_ceiling_state_id: 'eoc-haiku-ceiling-2026-05-28',
    defect_floor_state_id: 'eoc-haiku-defect-floor-2026-05-28',
    vault_layout: 'doc_keyed_with_prefix',
    vault_subdir_or_prefix: 'eoc-',
  },
};

// ── Back-compat alias for existing scorer/ground-truth/state-loader code ────
// `CanonicalField` now means "a canonical field name (string)"; per-site validity
// is enforced at runtime via PARSER_SITE_REGISTRY.canonical_fields lookup.

export type CanonicalField = string;

/** @deprecated Use PARSER_SITE_REGISTRY.plan_identity.doc_slugs instead. Kept for back-compat. */
export const CALIBRATION_DOCS = PLAN_IDENTITY_DOCS;
/** @deprecated Use string keys derived from per-site config. */
export type DocSlug = string;

// ── Field extraction + run artifact shapes (unchanged from pre-PR2) ─────────

/** Normalized per-field extraction shape — what every loader produces. */
export interface FieldExtraction {
  value: unknown;
  source_excerpt: string | null;
  source_section_hint?: string | null;
  confidence?: number | null;
  null_justification?: string | null; // PR3+ field
}

/** A single run of a state on a doc. Multi-run states (temp=1.0 baseline) have N entries. */
export interface RunArtifact {
  fields: Partial<Record<CanonicalField, FieldExtraction>>;
  raw_response?: string;
  parse_error: string | null;
  usage?: { input_tokens: number; output_tokens: number };
  elapsed_ms?: number;
  cost_usd?: number;
}

/** One calibration state across all docs for one parser_site. */
export interface CalibrationState {
  id: string;
  parser_site: ParserSite;
  label: string;
  date: string;
  session?: string;
  model: string;
  prompt: string;
  temperature: number | null;
  tool_use: boolean;
  /** Keyed by doc_slug (validated against PARSER_SITE_REGISTRY[parser_site].doc_slugs at load time). */
  by_doc: Record<string, RunArtifact[]>;
}

/** Per-(doc, field) ground truth derived via Option E cross-state consistency. */
export interface GroundTruthEntry {
  /** 'yes' = field IS in doc; 'no' = field genuinely absent; 'ambiguous' = ceiling sources disagree */
  present_in_doc: 'yes' | 'no' | 'ambiguous' | 'unknown';
  /** Value when present_in_doc='yes' (Opus value preferred when available; falls back to Haiku-ceiling) */
  value: unknown;
  opus_excerpt: string | null;
  haiku_ceiling_excerpt: string | null;
  /** True when only one ceiling source covers this field (lower confidence). */
  single_source: boolean;
  notes?: string;
}

export type GroundTruth = Record<string, Partial<Record<CanonicalField, GroundTruthEntry>>>;

/** Per-(state, doc, field) score. */
export interface FieldScore {
  field: CanonicalField;
  haiku_value: unknown;
  haiku_excerpt: string | null;
  /** Source_excerpt verifies in OCR via Pattern P-8. */
  verified: boolean;
  verify_method: 'exact' | 'normalized' | 'bridge' | 'not_found' | 'no_excerpt';
  /** Value is null AND ground truth confirms absence. */
  verified_null: boolean;
  /** Value non-null but excerpt unverifiable. */
  unverifiable: boolean;
  /** Value null but ground truth says field IS in doc. */
  spurious_null: boolean;
  /** Drift key Haiku emitted instead of canonical (only relevant for non-tool-use states). */
  drift_key: string | null;
  /** Per Opus reference (informational; doesn't penalize). */
  agrees_with_opus: boolean;
  disagrees_with_opus: boolean;
  /** Ground truth was indeterminate for this field. */
  ground_truth_ambiguous: boolean;
  /**
   * Value-vs-ground-truth comparison (stricter than excerpt verification):
   *   - `correct`: GT='yes' AND Haiku value agrees with GT value
   *   - `wrong`: GT='yes' AND Haiku value disagrees (or null when GT non-null)
   *   - `verified_absent`: GT='no' AND Haiku value is null
   *   - `false_positive`: GT='no' AND Haiku value is non-null
   *   - `unscored_unknown`: GT='unknown' (no reference) — Haiku may or may not be right; needs adjudication
   *   - `unscored_ambiguous`: GT='ambiguous' (ceiling sources disagree)
   */
  value_match: 'correct' | 'wrong' | 'verified_absent' | 'false_positive' | 'unscored_unknown' | 'unscored_ambiguous';
}

export interface DocScore {
  doc: string;
  state_id: string;
  per_field: FieldScore[];
  /** Primary monotonic-improvement metric — verified non-null fields. */
  fields_verifiable: number;
  /** Verified-null fields (also count toward "doing well"). */
  verified_null_count: number;
  /** Unverifiable non-null values (silent regression signal). */
  unverifiable_count: number;
  /** Spurious nulls — ground truth says present, state returned null. */
  spurious_null_count: number;
  drift_count: number;
  drift_keys: string[];
  agreement_with_opus_count: number;
  disagreement_with_opus_count: number;
  /** Runs where parse_error fired (raw text not JSON, or wrong shape). */
  format_failure_count: number;
  total_runs: number;
  cost_usd_total: number;
  latency_ms_p50: number | null;
  /** Value-vs-GT correctness counts. */
  value_correct_count: number;
  value_wrong_count: number;
  value_verified_absent_count: number;
  value_false_positive_count: number;
  value_unscored_unknown_count: number;
  value_unscored_ambiguous_count: number;
}

export interface StateScore {
  state_id: string;
  state_label: string;
  parser_site: ParserSite;
  by_doc: Record<string, DocScore>;
}

export interface ProgressTracker {
  schema_version: 2; // bumped from 1 in PR2 (parser_site axis added)
  generated_at: string;
  metrics: string[];
  /** Per-site breakdown. */
  sites: Array<{
    site: ParserSite;
    label: string;
    docs: readonly string[];
    canonical_fields: readonly string[];
    states: Array<{
      id: string;
      label: string;
      date: string;
      session?: string;
      model: string;
      prompt: string;
      temperature: number | null;
      tool_use: boolean;
    }>;
    scores: StateScore[];
    ground_truth: GroundTruth;
  }>;
}
