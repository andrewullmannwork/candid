-- =============================================================================
-- MIGRATION 116 — B2.3 /support redesign per §1.B.3 (S123)
-- =============================================================================
--
-- Extends support_tickets with category + linked-document + attachment columns
-- and seeds the support_faq_v1 feature flag (default OFF for MVP per
-- D-§1.B.3-B). All changes additive per Pattern 1 #10 + CLAUDE.md Rule #7.
--
-- WHY:
--   B2.3 ships the full support page redesign per [[plans/phase2_implementation]]
--   Status Tracker row 13: rich form (5 categories + char counter + linked doc +
--   file attachment + consent + 2-col layout per D-§1.B.3-A) + HIPAA copy strike
--   NON-NEGOTIABLE per D-§1.B.3-C + FAQ section flag-gated OFF for MVP per
--   D-§1.B.3-B.
--
--   The flag stays OFF at MVP launch. Curated FAQ content not yet authored;
--   flip ON when the 4 FAQ entries are written + admin-reviewed.
--
-- SCHEMA NOTES:
--   - `category` is TEXT (open vocabulary; matches 5 design IDs: bill/plan/
--     benefits/billing/other). No CHECK constraint — future categories possible
--     without migration. NULL allowed for legacy rows.
--   - `linked_document_id` UUID FK to documents.id ON DELETE SET NULL — keep
--     ticket if user deletes the linked doc. NULL allowed (optional field +
--     legacy rows).
--   - `attachment_url` TEXT NULL — Supabase Storage path within the
--     `support-attachments` bucket. Bucket creation + RLS policies must be
--     applied via Supabase Dashboard before PROD-promote (bucket creation via
--     SQL INSERT into storage.buckets is unreliable across Supabase setups).
--   - `attachment_filename` TEXT NULL — display name preserved separately for
--     UX (URL is path-based, not user-friendly).
--
-- STORAGE BUCKET SETUP (Dashboard, pre-PROD-promote):
--   1. Create bucket `support-attachments` (private; not public)
--   2. RLS policy: authenticated users INSERT under {user_id}/... path
--   3. RLS policy: authenticated users SELECT under {user_id}/... path (for
--      signed URL generation)
--   4. RLS policy: admins SELECT all (for ticket review)
--
-- ROLLBACK:
--   Columns are additive; no rollback path needed. Flag row removal forbidden
--   per Pattern 1 #10. To disable FAQ surface post-deploy: keep flag OFF.
-- =============================================================================

-- ---- Schema additions to support_tickets ------------------------------------

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS linked_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attachment_url TEXT,
  ADD COLUMN IF NOT EXISTS attachment_filename TEXT;

COMMENT ON COLUMN support_tickets.category IS 'B2.3 — open vocabulary; design ships 5 categories (bill/plan/benefits/billing/other). NULL for legacy pre-B2.3 tickets.';
COMMENT ON COLUMN support_tickets.linked_document_id IS 'B2.3 — optional FK to documents.id for bill-category tickets. ON DELETE SET NULL preserves ticket.';
COMMENT ON COLUMN support_tickets.attachment_url IS 'B2.3 — Supabase Storage path within support-attachments bucket. NULL when no attachment.';
COMMENT ON COLUMN support_tickets.attachment_filename IS 'B2.3 — display name for attachment (path is not user-friendly).';

-- Index for admin queries filtering by category
CREATE INDEX IF NOT EXISTS idx_support_tickets_category ON support_tickets(category) WHERE category IS NOT NULL;

-- ---- Feature flag seed: support_faq_v1 (default OFF per D-§1.B.3-B) --------

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'support_faq_v1',
  false,
  'B2.3 (Session 123). Gates the "Common questions" FAQ card on the right rail of /support. When OFF (default), the card is not rendered. When ON, the card renders 4 FAQ entries (currently dummy non-functional buttons in design; functional accordion deferred). Flip ON only after curated FAQ content is authored + admin-reviewed. Per D-§1.B.3-B Phase 1 §1.B.3 lockdown.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
