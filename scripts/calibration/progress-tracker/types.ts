/**
 * Calibration progress tracker — types.
 *
 * Per S136 critical review + Andrew approval (2026-05-28):
 *   - Canonical metric: monotonic improvement of `fields_verifiable` per (state, doc)
 *   - Opus is REFERENCE data, not gold (disagreements flagged, not penalized)
 *   - Ground truth derived from cross-state consistency (Option E)
 */

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
export type CanonicalField = (typeof CANONICAL_PLAN_IDENTITY_FIELDS)[number];

export const CALIBRATION_DOCS = [
  'oap-buy-up',
  'ambetter-bronze-ppo-ca',
  'gold-80-hmo',
  'anthem-in-17575IN0990006',
  'ecm-eoc',
] as const;
export type DocSlug = (typeof CALIBRATION_DOCS)[number];

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

/** One calibration state across all docs. */
export interface CalibrationState {
  id: string;
  label: string;
  date: string;
  session?: string;
  model: string;
  prompt: string;
  temperature: number | null;
  tool_use: boolean;
  by_doc: Partial<Record<DocSlug, RunArtifact[]>>;
}

/** Per-(doc, field) ground truth derived via Option E cross-state consistency. */
export interface GroundTruthEntry {
  /** 'yes' = field IS in doc; 'no' = field genuinely absent; 'ambiguous' = ceiling sources disagree */
  present_in_doc: 'yes' | 'no' | 'ambiguous' | 'unknown';
  /** Value when present_in_doc='yes' (Opus value preferred; falls back to Haiku-comprehensive) */
  value: unknown;
  opus_excerpt: string | null;
  haiku_ceiling_excerpt: string | null;
  /** True when only one ceiling source covers this field (lower confidence). */
  single_source: boolean;
  notes?: string;
}

export type GroundTruth = Partial<Record<DocSlug, Partial<Record<CanonicalField, GroundTruthEntry>>>>;

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
  doc: DocSlug;
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
  by_doc: Partial<Record<DocSlug, DocScore>>;
}

export interface ProgressTracker {
  schema_version: 1;
  generated_at: string;
  metrics: string[];
  docs: readonly DocSlug[];
  canonical_fields: readonly CanonicalField[];
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
}
