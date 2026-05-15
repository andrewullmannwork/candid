-- S92 (Session 92) — Parse Quality Flywheel substrate (Pattern P-Q).
--
-- Adds four additive columns to `documents` so every parse records its quality
-- score + the layout label + the dominant failure mode + a clustering signature
-- (layout::failure_mode). The signature is the GROUP BY key used by the S93
-- admin tuning UI to surface "47 docs all share this layout+failure-mode" —
-- one prompt-tweak fixes many failing docs at once.
--
-- Covers BOTH plan-doc and bill parsers (`source_type` discriminator already on
-- the documents table; quality columns are parser-agnostic).
--
-- All columns are NULLABLE — back-fills are not required. New parses populate
-- on write; old rows stay NULL. The admin queue (S93) queries
-- `WHERE parse_quality_score IS NOT NULL AND parse_quality_score < threshold`,
-- so unscored historic rows are naturally excluded.
--
-- Pattern P-Q "query-don't-store" architecture: this table is the live failure
-- intel feed. Tuning corpus is a query against rows below the relative
-- bottom-decile threshold (configurable per doc-type via the
-- `parse_quality_tuning_v1` feature flag's `config` JSONB). No separate
-- training-set storage — preserves HIPAA story (user data is processed under
-- existing parsing consent, not stockpiled).
--
-- Threshold rationale: bottom-decile rather than static "80%" because as the
-- parser improves the absolute floor moves with it. Static thresholds catch
-- nothing once the parser averages 90%+.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS parse_quality_score        REAL,
  ADD COLUMN IF NOT EXISTS parse_quality_layout       TEXT,
  ADD COLUMN IF NOT EXISTS parse_quality_failure_mode TEXT,
  ADD COLUMN IF NOT EXISTS parse_quality_signature    TEXT;

COMMENT ON COLUMN documents.parse_quality_score IS
  'S92 — parse_quality_score (0..1). Composite of cite-grade rate + plan-identity populated rate + warning-signature weight. Drives the relative bottom-decile threshold for the parse-quality tuning queue (Pattern P-Q).';

COMMENT ON COLUMN documents.parse_quality_layout IS
  'S92 — layout label emitted by Stage A layout detection (plan_doc/layout-detector.ts). Examples: federal_sbc_8page, federal_sbc_csr_variant, full_eoc_narrative, employer_plan_booklet, plan_cert_summary, unknown. Used as the first part of parse_quality_signature.';

COMMENT ON COLUMN documents.parse_quality_failure_mode IS
  'S92 — dominant failure mode derived from parse output: truncation_retry, plan_identity_low, services_zero, peo_sponsor_confusion, extraction_failed, etc. Used as the second part of parse_quality_signature. NULL when parse succeeded (parse_quality_score >= threshold).';

COMMENT ON COLUMN documents.parse_quality_signature IS
  'S92 — clustering key: {layout}::{failure_mode} (e.g., federal_sbc_8page::truncation_retry). NULL for successful parses. Admin tuning UI groups failing docs by signature so a single prompt-tweak fixes a cohort of similar failures.';

-- Index supports the admin queue's primary query: "show me failing docs
-- grouped by signature, sorted by count." Partial index keeps the cost down
-- since most rows will be NULL.
CREATE INDEX IF NOT EXISTS idx_documents_parse_quality_signature
  ON documents (parse_quality_signature)
  WHERE parse_quality_signature IS NOT NULL;

-- Threshold + per-doc-type tuning knobs feature-flagged so admin can tune
-- without a code deploy. Mirrors mig 099's shape (target_type + config JSONB;
-- flag_key UNIQUE per `feedback_candid_feature_flag_schema`).
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'parse_quality_tuning_v1',
  true,
  'S92 (Session 92) — Pattern P-Q Parse Quality Flywheel substrate. Enables parse-quality scoring at parse-write time + admin queue surfacing in S93. Per-doc-type relative-bottom-decile tuning thresholds (admin-tunable; default 0.10 = bottom 10% by score within doc-type). When enabled=false, parsers skip quality-scoring computation entirely (legacy path; no admin-queue surface).',
  'global',
  '{"plan_doc_bottom_decile":0.10,"bill_bottom_decile":0.10,"min_sample_size_for_decile":20,"absolute_floor_fallback":0.80}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
