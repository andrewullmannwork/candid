-- Migration 061: Phase 3.1A Task 3.1A-B — concept_admin_review_queue.
-- Per plans/phase_3.1A_eoc_parser_and_data_layer_readiness.md DR-3.1A-B (approved Session 51, 2026-05-01).
--
-- Pattern 1 #1 admin gate: when EOC parser extracts a CPT/HCPCS/NDC/REV/DRG code
-- that does NOT match an existing `concepts` row, the parser MUST NOT auto-create
-- the concept. Instead, parser enqueues the unknown code here for admin review.
-- Mirrors the proposed-changes queue idiom from mig 051 (insurer_appeals_proposed_changes).
--
-- Workflow:
--   1. EOC parser extracts (billing_code, billing_code_type) → check `concepts`
--   2. NO MATCH → INSERT row here (UPSERT on doc-scoped uniqueness; reprocess-safe)
--   3. Admin reviews via /admin/concept-review (route stub in 3.1A-D; full UI in follow-up)
--   4. On approve: admin uses existing concept-creation tooling to insert into `concepts`
--      + `service_catalog`; updates queue row with resolved_concept_id + resolved_service_slug
--   5. T0.4 reprocess re-runs EOC parser; the now-MATCH path writes to plan_covered_services
--
-- Pattern P-8 source provenance: every queued row carries ALL 5 source_* sub-keys
-- as flat columns (vs nested JSONB in field_provenance) — admin queries filter on
-- source_excerpt_verified frequently; flat columns enable cheap WHERE clauses.
--
-- Hard rules respected:
--   - CLAUDE.md §3 (billing_code + billing_code_type pair): CHECK constraint enforces type
--   - CLAUDE.md §1 (no duplicate entity tables): this is a QUEUE, not an entity table
--   - Pattern 1 #1 (admin > observation): never auto-create concepts
--   - CPT licensing: proposed_concept_label stored as raw extract; admin reviews +
--     types semantic name when creating concept (no direct paste of CPT description text)
--
-- Idempotency: UNIQUE(source_doc_id, billing_code, billing_code_type) — reprocess upserts.
--
-- Rollback: DROP TABLE concept_admin_review_queue CASCADE — clean removal; no consumer
-- reads in 3.1A; no FK dependents.

CREATE TABLE IF NOT EXISTS concept_admin_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source identification
  source_doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  proposed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- The proposed concept (raw from EOC parser; admin gates promotion to concepts table)
  proposed_billing_code TEXT NOT NULL,
  proposed_billing_code_type TEXT NOT NULL
    CHECK (proposed_billing_code_type IN ('CPT', 'HCPCS', 'NDC', 'REV', 'DRG')),
  proposed_concept_label TEXT,                  -- raw text from EOC; admin-only display
  proposed_service_slug TEXT,                    -- best-guess slug (regex/Haiku-suggested)

  -- Pattern P-8 source provenance (5 flat columns; matches the 5 sub-keys in field_provenance)
  source_excerpt TEXT,                           -- ≤200 chars verbatim from doc
  source_excerpt_verified TEXT
    CHECK (source_excerpt_verified IN ('verified', 'not_found', 'ocr_unverifiable')),
  source_excerpt_extraction_method TEXT
    CHECK (source_excerpt_extraction_method IN ('pdftotext', 'native_pdf_text', 'ocr')),
  source_section_hint TEXT,                      -- e.g., 'prior_auth_codes'
  source_section_verified BOOLEAN,

  -- Admin context aid (NOT a Pattern P-8 sub-key; ±500 chars around the code)
  context_extract TEXT,

  -- Workflow state (mirrors mig 051 pattern)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'needs_more_info')),
  reviewed_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  admin_notes TEXT,

  -- Resolution (populated on approve)
  resolved_concept_id UUID REFERENCES concepts(id) ON DELETE SET NULL,
  resolved_service_slug TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency: reprocess updates existing row, doesn't duplicate
  CONSTRAINT concept_review_queue_unique_per_doc
    UNIQUE (source_doc_id, proposed_billing_code, proposed_billing_code_type)
);

-- Partial index — most queries are "show pending" (mig 051 pattern)
CREATE INDEX IF NOT EXISTS idx_concept_review_queue_pending
  ON concept_admin_review_queue(created_at DESC)
  WHERE status = 'pending';

-- Per-doc lookups (admin "show me everything from this EOC")
CREATE INDEX IF NOT EXISTS idx_concept_review_queue_doc
  ON concept_admin_review_queue(source_doc_id, created_at DESC);

-- Cross-doc lookups (admin "is this code already pending from another doc?")
CREATE INDEX IF NOT EXISTS idx_concept_review_queue_code
  ON concept_admin_review_queue(proposed_billing_code, proposed_billing_code_type);

-- Auto-update timestamp (existing helper from mig 003 + 009 + others)
CREATE TRIGGER concept_review_queue_updated_at
  BEFORE UPDATE ON concept_admin_review_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS: defense-in-depth admin-only access (mig 003 + 009 pattern)
-- Parser writes happen via service role (bypasses RLS); only admin SELECT/UPDATE here.
ALTER TABLE concept_admin_review_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY concept_review_queue_admin_select ON concept_admin_review_queue
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

CREATE POLICY concept_review_queue_admin_update ON concept_admin_review_queue
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

COMMENT ON TABLE concept_admin_review_queue IS
  'Pattern 1 #1 admin gate for EOC parser unknown billing codes. Parser writes here when an extracted (billing_code, billing_code_type) does NOT match concepts; admin reviews and uses existing concept-creation tooling to promote. Reprocess upserts via per-doc UNIQUE constraint. Pattern P-8 source provenance carried as 5 flat columns. RLS admin-only; parser writes via service role.';
