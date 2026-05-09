-- =============================================================================
-- MIGRATION 084 — canonical_haiku_extractions cite-grade citations table (S72)
-- =============================================================================
--
-- WHY (S72-PLAN-DOC user direction Session 75 — CF-40 v3 dependency):
--   CF-40 v3 (mig 080+081+082) introduced per-(canonical, file_hash) parse-event
--   counter mechanic with multi-slot competing baselines. After 3 consecutive
--   identical parses, smart-skip fires and uploads #4+ skip Haiku entirely —
--   meaning users 4+ get `source='doc_extraction_smart_skip'` on their
--   `insurance_plans` row WITHOUT a cite-grade Pattern P-8 source_excerpt.
--
--   Without a citation fallback, smart-skipped users CANNOT blockquote verbatim
--   plan terms in dispute letters (CF-20 cite-grade gap). Dispute letters lose
--   legal force when they paraphrase rather than quote. The cost optimization
--   creates a citation regression.
--
--   This migration ships the storage layer that closes the gap: every Haiku run
--   from any plan-document parser (SBC + EOC + plan_doc) writes one row per
--   cite-grade Pattern P-8 extract to this table, indexed by (canonical, field).
--   Dispute-letter logic falls back to this table when the user's own row lacks
--   excerpt — pulls citations from any prior cite-grade Haiku run on the same
--   canonical + matching field.
--
-- WHAT THIS MIGRATION ADDS:
--   1. NEW `canonical_haiku_extractions` append-only table.
--   2. Indexes for (canonical, service_slug, field_name) lookup + haiku_run_id
--      grouping + source_user_doc_hash dedup + partial cite-grade index for the
--      dispute-letter fallback hot path.
--   3. RLS policies: service_role write (parsers); admin SELECT/UPDATE; user
--      SELECT only for own rows (auth.uid() = user_id). Dispute-letter cross-user
--      citation query uses service-role and selects only non-PII columns
--      (source_excerpt + source_section_hint).
--
-- PRIVACY CONSIDERATION:
--   Plan documents (SBC/EOC/plan_doc) are MASS-PRODUCED by carriers — millions
--   of users share the same canonical plan document. The verbatim text being
--   quoted is plan-language ("Generic drugs: $10 copay"), not user-specific PII.
--   Cross-user citation sharing is intentional + safe: dispute-letter fallback
--   query returns only the source_excerpt + source_section_hint columns;
--   user_id / document_id / source_user_doc_hash never leak across users.
--
--   Right-to-erasure: ON DELETE CASCADE on user_id + document_id means user
--   account deletion removes their cite-grade contributions. Other users'
--   dispute letters that depended on those citations gracefully degrade to
--   no-citation (paraphrase) until another user contributes a fresh cite-grade
--   extraction on the same canonical + field. Privacy precedence over citation
--   continuity is correct policy.
--
-- DEPENDENCIES:
--   - canonical_plans table (mig 020 + later)
--   - users table (mig 001)
--   - documents table (mig 003)
--
-- BACKOUT:
--   Application-layer rollback: revert TS code that writes to + reads from this
--   table. Existing data preserved per Pattern 1 #10 hard-delete prohibition.
-- =============================================================================

BEGIN;

-- ── 1. NEW canonical_haiku_extractions table ─────────────────────────────────

CREATE TABLE IF NOT EXISTS canonical_haiku_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity (canonical-side reference)
  canonical_plan_id UUID NOT NULL REFERENCES canonical_plans(id) ON DELETE CASCADE,
  service_slug TEXT,
  field_name TEXT NOT NULL,

  -- Provenance (user-side traceability)
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_user_doc_hash TEXT,
  haiku_run_id TEXT NOT NULL,
  parser_kind TEXT NOT NULL
    CHECK (parser_kind IN ('sbc', 'eoc', 'plan_doc')),

  -- Extraction
  extracted_value JSONB NOT NULL,

  -- Pattern P-8 source provenance (5-sub-key contract)
  source_excerpt TEXT,
  source_excerpt_verified TEXT
    CHECK (source_excerpt_verified IN ('verified', 'verbatim_absent', 'not_found', 'ocr_unverifiable')),
  source_section_hint TEXT,
  source_section_verified BOOLEAN,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_canonical_haiku_extractions_canonical_field
  ON canonical_haiku_extractions (canonical_plan_id, service_slug, field_name);

CREATE INDEX IF NOT EXISTS idx_canonical_haiku_extractions_run_id
  ON canonical_haiku_extractions (haiku_run_id);

CREATE INDEX IF NOT EXISTS idx_canonical_haiku_extractions_doc_hash
  ON canonical_haiku_extractions (source_user_doc_hash);

-- Partial index for the dispute-letter cite-grade fallback hot path
CREATE INDEX IF NOT EXISTS idx_canonical_haiku_extractions_cite_grade
  ON canonical_haiku_extractions (canonical_plan_id, service_slug, field_name)
  WHERE source_excerpt_verified = 'verified' AND source_section_verified = TRUE;

-- ── 3. RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE canonical_haiku_extractions ENABLE ROW LEVEL SECURITY;

-- Users can SELECT their own rows only (provenance/transparency for their own contributions)
CREATE POLICY "Users SELECT own canonical_haiku_extractions"
  ON canonical_haiku_extractions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = canonical_haiku_extractions.user_id
        AND u.id = auth.uid()
    )
  );

-- Admins SELECT all rows (admin queue + canonical-promotion-event tooling)
CREATE POLICY "Admins SELECT all canonical_haiku_extractions"
  ON canonical_haiku_extractions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.is_admin = true
    )
  );

-- Admins UPDATE for canonical-promotion-event admin tooling (e.g., manual
-- correction of a misclassified extraction's source_excerpt_verified value)
CREATE POLICY "Admins UPDATE canonical_haiku_extractions"
  ON canonical_haiku_extractions
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.is_admin = true
    )
  );

-- NO INSERT or DELETE policy — only service role writes (parsers). Append-only.
-- Cross-user dispute-letter citation query uses service-role and selects only
-- source_excerpt + source_section_hint (non-PII).

-- ── 4. Documentation ─────────────────────────────────────────────────────────

COMMENT ON TABLE canonical_haiku_extractions IS
  'S72 (Session 75). Append-only cite-grade citations table for dispute-letter Pattern P-8 verbatim resolution. Every cite-grade Haiku run from SBC + EOC + plan_doc parsers writes one row per (field, document, haiku_run). Dispute-letter logic falls back here when user''s own insurance_plans row lacks source_excerpt (smart-skip case post-CF-40 v3). Append-only — no UPDATE or DELETE from app code; admin UPDATE allowed for canonical-promotion-event admin tooling. Privacy: cross-user dispute-letter query (service-role) returns only source_excerpt + source_section_hint columns; PII columns (user_id / document_id / source_user_doc_hash) never leak across users.';

COMMENT ON COLUMN canonical_haiku_extractions.canonical_plan_id IS
  'Canonical plan this extraction is associated with. Cite-grade fallback queries pivot here.';

COMMENT ON COLUMN canonical_haiku_extractions.service_slug IS
  'Service slug for per-service field extractions (e.g., ''pcp_visit'', ''generic_drugs''). NULL for plan-identity-level fields (e.g., ''in_deductible_individual'').';

COMMENT ON COLUMN canonical_haiku_extractions.field_name IS
  'The specific field this row''s extracted_value + source_excerpt corresponds to. Examples: ''in_deductible_individual'', ''in_copay'', ''out_coinsurance'', ''how_to_access''.';

COMMENT ON COLUMN canonical_haiku_extractions.user_id IS
  'User who uploaded the source document. Required for RLS scoping — users SELECT their own rows only. Service-role queries (dispute-letter cross-user citations) bypass RLS and select only non-PII columns. ON DELETE CASCADE: user account deletion removes their cite-grade contributions; right-to-erasure precedence over citation continuity.';

COMMENT ON COLUMN canonical_haiku_extractions.document_id IS
  'Source document this extraction came from. Useful for forensic divergence tracing + admin audit. Cascade-deletes when document is deleted (per Pattern 1 #10 user-data right-to-erasure).';

COMMENT ON COLUMN canonical_haiku_extractions.source_user_doc_hash IS
  'file_hash of the source document. Enables admin dedup queries + telemetry (e.g., "how many distinct hashes contributed cite-grade extractions for this canonical?").';

COMMENT ON COLUMN canonical_haiku_extractions.haiku_run_id IS
  'Groups all field extractions from the same Haiku call (e.g., one SBC parse produces ~30-40 rows, all sharing a haiku_run_id). Useful for forensic divergence tracing — query SELECT * WHERE haiku_run_id = $1 to see everything that one Haiku call extracted from one user''s upload.';

COMMENT ON COLUMN canonical_haiku_extractions.parser_kind IS
  'Which parser produced this extraction: ''sbc'' (SBC parser per Phase 3.2), ''eoc'' (EOC parser per Phase 3.1A), or ''plan_doc'' (plan_doc Haiku-first parser per S72 Phase 3.1A pattern). Used for parser-quality telemetry.';

COMMENT ON COLUMN canonical_haiku_extractions.extracted_value IS
  'The Haiku-extracted value for this (canonical, service_slug, field_name) tuple. JSONB to handle scalars, currency, percentages, and structured values uniformly.';

COMMENT ON COLUMN canonical_haiku_extractions.source_excerpt IS
  'Verbatim quote (≤200 chars) from the source document corroborating extracted_value. The text dispute letters blockquote. NULL when Haiku produced a value but no excerpt (Pattern P-8 not satisfied).';

COMMENT ON COLUMN canonical_haiku_extractions.source_excerpt_verified IS
  'Pattern P-8 verification status: ''verified'' (excerpt exists in document text post-whitespace-normalize), ''verbatim_absent'' (excerpt provided but not found verbatim — paraphrase), ''not_found'' (no excerpt provided), ''ocr_unverifiable'' (document is image PDF; verification skipped). Only ''verified'' rows + source_section_verified=TRUE qualify for dispute-letter citation per Pattern P-8 hard rule.';

COMMENT ON COLUMN canonical_haiku_extractions.source_section_hint IS
  'Section name Haiku claimed it extracted from (e.g., ''Common Medical Events''). Verified against actual document section structure via verifySourceExcerpts.';

COMMENT ON COLUMN canonical_haiku_extractions.source_section_verified IS
  'TRUE when source_section_hint matches an actual section in the document. Pattern P-8 cite-grade gate also requires this TRUE.';

COMMIT;
