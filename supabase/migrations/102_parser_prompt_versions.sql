-- Migration 102: parser_prompt_versions table for Pattern P-Q admin tuning UI (S93 Stage 5a).
--
-- Codifies the storage substrate for human-in-the-loop Haiku prompt tuning per
-- the Pattern P-Q architecture (Candid_Parse_Patterns, S92 codification) +
-- the locked Stage 5 design (S93 mocks signed off 2026-05-14).
--
-- Each row = one immutable version of one supplement (e.g., the federal-SBC
-- tabular supplement) within one prompt file. Exactly one row per
-- (prompt_file_path, supplement_key) is `is_active=TRUE` at any time. The
-- DB-backed prompt loader (src/lib/plan_doc/prompt-loader.ts) reads the active
-- row at parse time with a 5-min in-process cache. When no active row exists
-- (initial state pre-tuning or DB outage), the loader falls back to the
-- compile-time const in the prompt file (the source-of-truth for v1).
--
-- LOCKED DECISIONS reflected in this schema:
--   1. Drafting via Path C (Claude Code export) — no autonomous LLM rewriting;
--      `notes` column captures the human author's summary.
--   2. Storage = DB-backed at parse time — no code redeploy on save.
--   3. Save gate = block on >5pt single-fixture regression OR SBC aggregate
--      below baseline — `regression_test_results` JSONB is required (NOT NULL).
--   4. Versions are immutable — no UPDATE on existing rows; revert creates a
--      NEW version with copy of older `full_prompt_text`.
--   5. Hot-edits to haiku-prompts/*.ts files still possible (source of v1) but
--      flagged via drift-check (deferred to Stage 5b cleanup).
--
-- Stage 5a scope: this table + the loader + parser refactor to use the loader.
-- Stage 5b: read-only admin UI (clusters, samples). Stage 5c: write path
-- (editor, kickoff prompt generator, regression-test runner, save, revert).

CREATE TABLE IF NOT EXISTS parser_prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity of the prompt block this row versions
  prompt_file_path TEXT NOT NULL,    -- e.g., 'src/lib/plan_doc/haiku-prompts/services-cost-sharing.ts'
  supplement_key TEXT NOT NULL,      -- e.g., 'FEDERAL_SBC_TABULAR_SUPPLEMENT'
  version_number INT NOT NULL,       -- monotonic per (prompt_file_path, supplement_key)

  -- Content
  full_prompt_text TEXT NOT NULL,         -- complete prompt block at this version
  diff_against_prior_version TEXT,        -- unified diff vs version_number-1; NULL on v1
  notes TEXT,                             -- author summary (e.g., "Tighten verbatim discipline on multi-line cells")

  -- Authorship
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_email TEXT NOT NULL,             -- denormalized for audit (survives user deletion)
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Save gate evidence (mandatory per locked decision #3)
  -- Shape: {"fixtures":[{"id":"ambetter-bronze-60-hdhp","prior_score":0.972,"new_score":1.000,"delta":0.028},...],
  --         "sbc_aggregate":{"prior":0.868,"new":0.888,"delta":0.020},
  --         "eoc_aggregate":{"prior":0.901,"new":0.901,"delta":0.000},
  --         "gate_passed":true,
  --         "gate_reason":null,    -- when blocked, e.g. "ambetter-silver-87 regressed -6.3pts"
  --         "cost_usd":1.18,
  --         "ran_at":"2026-05-14T22:34:00Z"}
  regression_test_results JSONB NOT NULL,

  -- Active flag — exactly one TRUE per (prompt_file_path, supplement_key) enforced via partial unique index below
  is_active BOOLEAN NOT NULL DEFAULT FALSE,

  CONSTRAINT parser_prompt_versions_unique_version
    UNIQUE (prompt_file_path, supplement_key, version_number)
);

-- Exactly one active version per (file_path, supplement_key)
CREATE UNIQUE INDEX IF NOT EXISTS parser_prompt_versions_one_active
  ON parser_prompt_versions (prompt_file_path, supplement_key)
  WHERE is_active = TRUE;

-- Loader hot-path lookup (active row by file_path + supplement_key; partial filter avoids bloat)
CREATE INDEX IF NOT EXISTS parser_prompt_versions_active_lookup
  ON parser_prompt_versions (prompt_file_path, supplement_key)
  WHERE is_active = TRUE;

-- Version history list view (sorted by saved_at DESC per file/supplement)
CREATE INDEX IF NOT EXISTS parser_prompt_versions_history_lookup
  ON parser_prompt_versions (prompt_file_path, supplement_key, saved_at DESC);

-- RLS: admin-only writes; admin-self SELECT. Mirrors canonical_haiku_extractions pattern.
ALTER TABLE parser_prompt_versions ENABLE ROW LEVEL SECURITY;

-- Service-role bypass + admin SELECT policy (admin gating via app-layer admin-check;
-- RLS prevents non-admin user escalation via direct API)
CREATE POLICY parser_prompt_versions_service_role_all ON parser_prompt_versions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Comments for auditing
COMMENT ON TABLE parser_prompt_versions IS
  'S93 Stage 5a — immutable version log for Haiku prompt supplements (Pattern P-Q admin tuning UI substrate). One row per saved version of one supplement. Exactly one is_active=TRUE per (prompt_file_path, supplement_key). Loader at src/lib/plan_doc/prompt-loader.ts reads active row at parse time with 5-min cache; falls back to compile-time const when no row exists.';

COMMENT ON COLUMN parser_prompt_versions.prompt_file_path IS
  'Source file path of the prompt block. Used as registry key by the loader. Example: src/lib/plan_doc/haiku-prompts/services-cost-sharing.ts';

COMMENT ON COLUMN parser_prompt_versions.supplement_key IS
  'Identifier of the prompt block within the file. Example: FEDERAL_SBC_TABULAR_SUPPLEMENT. Use BASE for the master prompt (read-only via admin UI per locked decision).';

COMMENT ON COLUMN parser_prompt_versions.regression_test_results IS
  'JSONB capture of the regression-test gate result (mandatory per locked decision #3). Shape includes per-fixture before/after scores + aggregate deltas + gate_passed boolean + gate_reason on block + cost_usd + ran_at. Save endpoint validates gate_passed=true before INSERT.';

COMMENT ON COLUMN parser_prompt_versions.diff_against_prior_version IS
  'Unified diff vs version_number-1 for audit. NULL on v1 (no prior). Computed by save endpoint from prior is_active row text.';

COMMENT ON COLUMN parser_prompt_versions.is_active IS
  'TRUE for the version currently used by the loader. Exactly one TRUE per (prompt_file_path, supplement_key) enforced via partial unique index. Save endpoint flips prior active to FALSE then INSERTs new active TRUE in one transaction. Revert endpoint creates a NEW version copying older text + flips active.';
