-- =============================================================================
-- MIGRATION 133 — PR4 bill parser tool-use migration + decisions event log
--                 (B-1 per-line breakdown + B-2 header reconciliation +
--                  B-3 sign convention; pre-launch backend hardening)
-- =============================================================================
--
-- Combined migration adds:
--   1. `bill_parser_tool_use_v1` feature flag (default OFF) — gates the
--      Anthropic tool-use code path in haiku-bill-parser.ts. While OFF, the
--      legacy raw-JSON code path runs unchanged in PROD. While ON, the parser
--      calls Haiku with a strict input_schema tool definition + tool_choice
--      forcing the model to emit structured output (eliminates schema-key
--      drift class-of-bug from S136 reframe; per-line numeric fields are
--      required at the API validator layer rather than at the consumer layer).
--   2. `bill_parser_decisions` event-log table — append-only telemetry for
--      sign violations, per-line sparse / sum-mismatch verdicts, and header
--      reconciliation failures. Powers a NEW "bills" tab on /admin/review-queue
--      (Bills-C Option B precedent locked at S123: extend existing review-queue
--      surface rather than build new /admin/billing-review page).
--
-- WHY THIS MIGRATION EXISTS
--
-- Per `plans/pre_launch_backend_hardening.md` §3 row "Bill parser tool-use
-- migration (sign + per-line + header reconciliation)" — PR4 unified scope
-- absorbing B-1 + B-2 + B-3 sub-items per S140 frontend cite-grade discovery
-- (`plans/s140_flagged_body_cite_grade_fix.md`):
--
--   * B-1: bill parser populates claim-header totals (mig 092 fields) but
--     leaves per-line `claim_line_items.insurance_paid` /
--     `patient_paid_amount` / `insurance_adjusted_amount` NULL on most bills.
--     Frontend Path B helper pro-rates from header → marks
--     `provenance.citationSource='claim_header'` → dispute pipeline cites
--     header not per-line. PR4 tool-use schema requires per-line fields;
--     sum-equals-header verifier catches sparse outputs.
--   * B-2: Jun 23 PROD claim `4d8c0cad-...` has incoherent header totals
--     (`total_insurance_adjusted` == `total_billed` AND nonzero
--     `total_insurance_paid` → mathematically impossible). PR4 adds verifier
--     at persist time; on violation persists with `header_reconciliation_failed`
--     flag (Andrew Option B — admin review, never reject-and-quarantine per
--     S135 routing rule).
--   * B-3: prompt-side root cause of S135 sign-bandaid. PR4 patches Rule #13
--     with explicit positive-magnitude rule + few-shot negative-column EOB
--     example + REPLACES persist.ts `Math.abs()` bandaid with strict
--     invariant + admin review queue per `feedback_no_whack_a_mole_fixes`.
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. feature_flag_rules row:
--      flag_key:    bill_parser_tool_use_v1
--      enabled:     false (default OFF — PR4 ships under flag for smoke + soak)
--      target_type: global
--      config:      JSONB with tunable verifier tolerance constants
--                   {
--                     "per_line_sum_tolerance_abs":      0.01,
--                     "per_line_sum_tolerance_rel":      0.001,
--                     "header_reconciliation_abs":       0.50,
--                     "header_reconciliation_rel":       0.005,
--                     "tool_use_max_tokens":             32000
--                   }
--      Tunable via SQL UPDATE on feature_flag_rules.config without code deploy
--      (Ship Gate G6 compliance).
--
-- 2. `bill_parser_decisions` table — append-only event log; one row per persist
--    invocation that triggers any of:
--      a. sign_violation       (any of insurance_paid / insurance_adjusted /
--                                patient_paid arrived negative on input)
--      b. per_line_sparse      (per-line numeric fields NULL or sum-equals-
--                                header verifier failed; frontend falls back
--                                to Path B header pro-ration)
--      c. header_reconciliation_failed
--                              (total_billed - sum(per-claim totals) exceeds
--                                tolerance)
--      d. clean                (all verifiers passed — recorded so we can
--                                surface both fire AND non-fire paths per
--                                Ship Gate G7 silent-regression detection)
--
-- VERDICT ENUM (closed set via CHECK constraint)
--
--   'clean'                            — all verifiers passed
--   'sign_violation'                   — negative magnitude on input
--   'per_line_sparse'                  — per-line fields NULL or sum mismatch
--   'header_reconciliation_failed'     — header total balance off
--   'multi'                            — multiple verdicts fired on same claim
--                                        (detail in metadata)
--
-- BACKOUT — additive only. Flag row: `DELETE FROM feature_flag_rules WHERE
-- flag_key = 'bill_parser_tool_use_v1';` reverts parser to legacy raw-JSON
-- path (isFeatureEnabled returns false on missing row). Table: `DROP TABLE
-- bill_parser_decisions;` reverts to no observability (persist.ts decision
-- writes are non-fatal try/catch — caller path unaffected). No FKs to
-- documents / claims to keep telemetry loosely coupled (matches mig 124
-- canonical_match_decisions pattern). Forensic telemetry survives document /
-- claim deletion.

BEGIN;

-- ============================================================================
-- SECTION 1: bill_parser_tool_use_v1 feature flag
-- ============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'bill_parser_tool_use_v1',
  false,
  'PR4 (S142). Gates the Anthropic tool-use code path in haiku-bill-parser.ts. OFF (default): legacy raw-JSON-in-prompt + parseHaikuJSON code path runs (preserves existing PROD behavior; emergency revert path). ON: parser calls Haiku with a strict input_schema tool definition + tool_choice=tool forcing structured output. Tool schema requires per-line numeric fields (insurance_paid / patient_paid / ins_adjusted) at the API validator layer — eliminates the S136 schema-key-drift class-of-bug for bills. Config JSONB carries Ship-Gate-G6-tunable verifier tolerance constants: per_line_sum_tolerance_abs ($0.01 floor) + per_line_sum_tolerance_rel (0.1% of header) + header_reconciliation_abs ($0.50 floor) + header_reconciliation_rel (0.5% of total_billed) + tool_use_max_tokens (32000 default). Tune via UPDATE feature_flag_rules SET config = jsonb_set(config, ''{per_line_sum_tolerance_rel}'', ''0.002'') WHERE flag_key = ''bill_parser_tool_use_v1''; — no code deploy required.',
  'global',
  jsonb_build_object(
    'per_line_sum_tolerance_abs',  0.01,
    'per_line_sum_tolerance_rel',  0.001,
    'header_reconciliation_abs',   0.50,
    'header_reconciliation_rel',   0.005,
    'tool_use_max_tokens',         32000
  )
)
ON CONFLICT (flag_key) DO NOTHING;

-- ============================================================================
-- SECTION 2: bill_parser_decisions event-log table
-- ============================================================================

CREATE TABLE IF NOT EXISTS bill_parser_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID,
  claim_id UUID,
  user_id UUID,
  verdict TEXT NOT NULL
    CHECK (verdict IN (
      'clean',
      'sign_violation',
      'per_line_sparse',
      'header_reconciliation_failed',
      'multi'
    )),
  -- Sign-violation detail. NULL when verdict in ('clean', 'per_line_sparse',
  -- 'header_reconciliation_failed') unless verdict='multi' AND sign-violation
  -- also fired.
  sign_violation_fields TEXT[],
  -- Per-line sum detail.
  per_line_sum_details JSONB,
  -- Header reconciliation detail.
  header_reconciliation_delta NUMERIC,
  header_reconciliation_tolerance NUMERIC,
  -- Parser path provenance. Helps admin distinguish whether tool-use vs raw-
  -- JSON path produced the decision when soak rolls the flag forward.
  parser_path TEXT NOT NULL
    CHECK (parser_path IN ('raw_json', 'tool_use')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Admin review state. Pending by default; admin can dismiss with reason.
  review_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'dismissed', 'escalated', 'resolved')),
  review_reason TEXT,
  reviewed_by_user_id UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bpd_document_id
  ON bill_parser_decisions (document_id);

CREATE INDEX IF NOT EXISTS idx_bpd_claim_id
  ON bill_parser_decisions (claim_id);

CREATE INDEX IF NOT EXISTS idx_bpd_verdict_created_at
  ON bill_parser_decisions (verdict, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bpd_review_state_created_at
  ON bill_parser_decisions (review_state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bpd_created_at
  ON bill_parser_decisions (created_at DESC);

COMMENT ON TABLE bill_parser_decisions IS
  'PR4 (S142). Append-only event log of bill parser persist-time verifier outcomes. One row per claim persist call when ANY verdict fires (clean, sign_violation, per_line_sparse, header_reconciliation_failed, multi). Powers /admin/review-queue bills tab (Bills-C Option B precedent — extend existing surface rather than new page). Ship Gate G7 silent-regression detection: writes BOTH fire AND non-fire paths so admin can detect verdict-rate drift. Server-only writes via bill-parser-decisions helper; no RLS. Non-fatal write path — failures are logged + swallowed (matches mig 124 canonical_match_decisions pattern); persist caller is unaffected.';

COMMENT ON COLUMN bill_parser_decisions.document_id IS
  'Optional documents.id — the upload that produced this claim. NULL when persist invoked outside upload flow (test/admin scripts). Soft reference; no FK so telemetry survives document deletion.';

COMMENT ON COLUMN bill_parser_decisions.claim_id IS
  'Optional claims.id — the persisted claim (if persist succeeded). NULL when persist short-circuited before claim insert. Soft reference; no FK.';

COMMENT ON COLUMN bill_parser_decisions.user_id IS
  'Optional users.id — the uploader. NULL when persist invoked outside user flow. Soft reference; no FK.';

COMMENT ON COLUMN bill_parser_decisions.verdict IS
  'Closed-set CHECK enum. clean = all verifiers passed (B-1 sum + B-2 header + B-3 sign). sign_violation = any negative-magnitude input on writeoff/payment fields. per_line_sparse = per-line numeric fields NULL or sum-equals-header verifier failed (frontend falls back to Path B header pro-ration). header_reconciliation_failed = |total_billed - total_adjusted - total_paid - total_patient_paid| > tolerance. multi = multiple verdicts fired on the same claim (detail in metadata.verdicts array).';

COMMENT ON COLUMN bill_parser_decisions.sign_violation_fields IS
  'When verdict involves sign_violation: list of field names that arrived negative on input (e.g., [''insurance_paid'', ''total_insurance_adjusted'']). NULL when verdict has no sign component.';

COMMENT ON COLUMN bill_parser_decisions.per_line_sum_details IS
  'When verdict involves per_line_sparse: JSONB with { field, line_sum, header, delta, tolerance } per failing field. NULL when verdict has no per-line component.';

COMMENT ON COLUMN bill_parser_decisions.header_reconciliation_delta IS
  'When verdict=header_reconciliation_failed or multi: absolute delta |billed - adjusted - paid - patient_paid|. NULL otherwise.';

COMMENT ON COLUMN bill_parser_decisions.header_reconciliation_tolerance IS
  'When verdict involves header reconciliation: the tolerance threshold computed as max(header_reconciliation_abs, total_billed * header_reconciliation_rel). Lets admin spot-check tolerance calibration.';

COMMENT ON COLUMN bill_parser_decisions.parser_path IS
  'Which code path produced the input — raw_json (legacy parseHaikuJSON; flag OFF) or tool_use (Anthropic input_schema; flag ON). Lets admin attribute verdict-rate trends to the parser migration.';

COMMENT ON COLUMN bill_parser_decisions.metadata IS
  'Free-form JSONB. May include: original Haiku response excerpt (raw values pre-invariant), input_signature for repeat-upload grouping, verdicts array when verdict=multi, line numbers that violated. Bounded ≤4KB by application code.';

COMMENT ON COLUMN bill_parser_decisions.review_state IS
  'pending = awaiting admin review. dismissed = admin marked false-positive / not actionable. escalated = admin flagged for engineering follow-up. resolved = admin confirmed the underlying claim has been corrected (reparse or manual edit). Default pending.';

COMMIT;
