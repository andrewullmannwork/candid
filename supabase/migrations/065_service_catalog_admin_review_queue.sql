-- Migration 065: service_catalog_admin_review_queue (Pattern 1 #1 admin gate for slugs)
--
-- Bundle PR #1 / Session 55 — extends audit item #8 fix from "drop with warning"
-- (anti-flywheel) to "queue for admin promotion" (correct flywheel pattern).
--
-- BACKGROUND
-- Pattern 1 hard rule #1: parsers MUST NOT auto-create reference data; admin gate
-- enforced. mig 061 (Phase 3.1A) implemented this for billing codes via
-- concept_admin_review_queue. Service slugs (service_catalog entries) had the
-- same architectural need but the queue was deferred ("v1.5+ TODO" in
-- src/lib/sbc/concept-resolver.ts:8-10) — never assigned a session pointer.
--
-- IMPACT OF THE GAP
-- Without this queue, every parsed document mentioning an out-of-catalog service
-- (Haiku-emitted slugs that don't exist in service_catalog yet) was DROPPED to
-- parse_audit_runs.warnings JSONB — buried, not aggregated, not promotable.
-- USER A and USER B both mentioning "tier_4_specialty_infusion" should be a
-- 2-user signal that service_catalog should grow; today that signal is lost.
--
-- This table mirrors mig 061's structure (queue idiom; flat Pattern P-8 columns
-- for cheap admin filtering) modulo billing-code-specific columns swapped for
-- slug-specific ones.
--
-- WORKFLOW (mirrors mig 061 §Workflow)
--   1. Parser (SBC / EOC / plan_document) emits service_slug → check service_catalog
--   2. NO MATCH → INSERT row here (UPSERT on doc-scoped uniqueness; reprocess-safe)
--   3. Admin reviews via /admin/review-queue (NEW UI in same Bundle PR #1)
--   4. On approve: admin uses existing service_catalog seeding tooling (or inline UI)
--      to insert into service_catalog; updates queue row with resolved_service_slug
--      + status='promoted'
--   5. T0.4 reprocess re-runs parser; the now-MATCH path writes to plan_covered_services
--      coverage_rules
--
-- HARD RULES RESPECTED
--   - CLAUDE.md §1 (no duplicate entity tables): this is a QUEUE, not entity table
--   - CLAUDE.md §3 (billing_code + billing_code_type pair): N/A (slug-only queue)
--   - Pattern 1 #1 (admin > observation): never auto-create service_catalog rows
--   - Pattern 1 #11 (methodology disclosure): admin-promoted slugs flagged in
--     service_catalog.metadata for downstream provenance
--
-- IDEMPOTENCY: UNIQUE(source_doc_id, proposed_service_slug) — reprocess upserts
-- (same doc + same slug) without creating duplicates. Different docs proposing
-- the same slug create separate rows (signal aggregation = COUNT(*) GROUP BY slug).
--
-- ROLLBACK: DROP TABLE service_catalog_admin_review_queue CASCADE
--   No FK dependents at v1; no consumer reads outside admin surface.

CREATE TABLE IF NOT EXISTS service_catalog_admin_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source identification
  source_doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  proposed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Which parser surfaced this unknown slug — filters admin queue + signals priority
  parser_source TEXT NOT NULL
    CHECK (parser_source IN ('sbc', 'eoc', 'plan_document', 'eob', 'card', 'manual')),

  -- The proposed service catalog entry (raw from parser; admin gates promotion)
  proposed_service_slug TEXT NOT NULL,                -- Haiku-emitted slug; admin reviews
  proposed_service_label TEXT,                        -- raw text from doc; admin-only display
  proposed_category TEXT,                             -- best-guess category (Haiku may suggest)

  -- Pattern P-8 source provenance (5 flat columns; matches the 5 sub-keys in field_provenance)
  source_excerpt TEXT,                                -- ≤200 chars verbatim from doc
  source_excerpt_verified TEXT
    CHECK (source_excerpt_verified IN ('verified', 'not_found', 'ocr_unverifiable')),
  source_excerpt_extraction_method TEXT
    CHECK (source_excerpt_extraction_method IN ('pdftotext', 'native_pdf_text', 'ocr')),
  source_section_hint TEXT,                           -- e.g., 'medical_necessity' (EOC) or 'common_medical_events' (SBC)
  source_section_verified BOOLEAN,

  -- Admin context aid (NOT a Pattern P-8 sub-key; ±500 chars around the slug emission)
  context_extract TEXT,

  -- Workflow state (mirrors mig 061 pattern)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'promoted', 'rejected')),
  -- Set when admin promotes: the service_catalog.slug that this proposal resolved to.
  -- May differ from proposed_service_slug if admin renames during promotion (e.g.,
  -- 'tier4_infusion' → 'specialty_infusion_tier4'). Reprocess routes via this slug.
  resolved_service_slug TEXT,
  -- Optional rejection reason (free text; admin notes for audit trail)
  rejection_reason TEXT,
  -- Admin who acted on this row (FK users.id)
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: same doc proposing same slug → UPSERT, not duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS service_catalog_admin_review_queue_doc_slug_uniq
  ON service_catalog_admin_review_queue (source_doc_id, proposed_service_slug);

-- Admin filter indexes
CREATE INDEX IF NOT EXISTS service_catalog_admin_review_queue_status_idx
  ON service_catalog_admin_review_queue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS service_catalog_admin_review_queue_parser_status_idx
  ON service_catalog_admin_review_queue (parser_source, status);
-- Signal aggregation: count distinct docs per slug to gauge promotion priority
CREATE INDEX IF NOT EXISTS service_catalog_admin_review_queue_slug_status_idx
  ON service_catalog_admin_review_queue (proposed_service_slug, status);

-- BEFORE UPDATE trigger: keep updated_at fresh (mirrors mig 061 pattern)
CREATE OR REPLACE FUNCTION trg_service_catalog_admin_review_queue_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_catalog_admin_review_queue_updated_at_trg
  ON service_catalog_admin_review_queue;
CREATE TRIGGER service_catalog_admin_review_queue_updated_at_trg
  BEFORE UPDATE ON service_catalog_admin_review_queue
  FOR EACH ROW EXECUTE FUNCTION trg_service_catalog_admin_review_queue_updated_at();

COMMENT ON TABLE service_catalog_admin_review_queue IS
  'Pattern 1 #1 admin gate for service_catalog slug growth. Parsers (SBC/EOC/plan_document) emit unknown slugs to this queue; admin reviews + promotes to service_catalog. Bundle PR #1 (Session 55, audit item #8 full close). Mirrors mig 061 (concept_admin_review_queue) for billing codes.';

GRANT SELECT, INSERT, UPDATE ON service_catalog_admin_review_queue TO authenticated, service_role;
