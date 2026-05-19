-- =============================================================================
-- MIGRATION 109 — Add documents.metadata JSONB column
-- (S99 B5 — fixes silent-rejection bug discovered during B5 manual smoke)
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
-- The codebase has 9 write sites + 4 read sites referencing `documents.metadata`
-- but the column was never created. Every UPDATE that includes `metadata: {...}`
-- has been silently rejected by PostgREST with PGRST204, and supabase-js does NOT
-- throw on this — it returns the error inside `{ data, error }` and existing call
-- sites don't check `.error`. Result: every metadata write has been a no-op since
-- it was first introduced (S91 doc-type override logging, S98+ B5 halt + sanity
-- gate, status route, confirm-doc-type endpoint).
--
-- WHAT BREAKS UNDER THE BUG
--
-- 1. S91 (mig 099) doc-type override path UPDATE bundles `doc_type` + `metadata`.
--    PGRST204 rejects the WHOLE call, so `doc_type` was never being updated when
--    the classifier overrode the user's pick. Downstream routing still worked
--    because process-chunk re-classifies via its own Haiku call. But the
--    classification_override audit-trail never persisted, and the admin-tuning
--    UI received no data from this surface.
--
-- 2. S99 B5 halt path tries to write status='awaiting_user_confirmation' +
--    processing_step='awaiting_doc_type_confirmation' + metadata in ONE UPDATE.
--    PGRST204 rejects all three writes; doc stays at status='uploaded'. The API
--    handler still returns awaitingDocTypeConfirmation:true, but the document is
--    orphaned in 'uploaded' state with no path to resume processing.
--
-- 3. confirm-doc-type endpoint reads `doc.metadata.doc_type_confirmation.options`
--    to validate the user's confirmation choice against the modal's offered
--    options. With metadata empty, the validation gracefully degrades to the
--    hardcoded ALLOWED_DOC_TYPES set — looser than intended but not broken.
--
-- 4. process-chunk's bill-parser sanity gate (B5) reads
--    `metaDoc?.metadata?.classification_override?.page_count` for page-count
--    context. Without metadata, the sanity gate has no page count and falls
--    back to its own resolution path. Less precise but not broken.
--
-- BEHAVIOR CHANGES ONCE MIG 109 LANDS
--
-- - All previously-silent UPDATEs start persisting. Most paths gain audit-trail
--   data they were supposed to have. NO functional regression — process-chunk's
--   independent re-classification was already compensating for the unset doc_type.
-- - S91 override path's doc_type updates start landing. Process-chunk's userType
--   input becomes more accurate. Edge case where process-chunk's Haiku is
--   unavailable now falls back to the more-accurate upload-time classifier
--   verdict instead of the user's wrong pick. STRICT IMPROVEMENT.
-- - B5 halt path becomes functional end-to-end: status + processing_step
--   transitions work, modal renders, confirm-doc-type re-enqueues the document.
--
-- BACKOUT
--
-- ALTER TABLE documents DROP COLUMN metadata;
-- (Idempotent; safe if column wasn't created. Code reads use optional chaining
-- and gracefully handle missing column / null value.)
--
-- ROLLOUT
--
-- Apply to PROD via Supabase Studio before merging the B5 PR. Existing rows get
-- the DEFAULT '{}'::jsonb fill at column-add time (metadata-only operation in
-- Postgres 11+; no full table rewrite). New uploads + status route updates +
-- confirm-doc-type updates start persisting metadata immediately.
-- =============================================================================

BEGIN;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN documents.metadata IS
  'S99 B5 (mig 109). Generic JSONB for per-document metadata: classification_override (S91 audit-trail of doc-type resolution), doc_type_confirmation (B5 modal halt context: user_pick + classifier_pick + options + presented_at), doc_type_confirmation_result (user''s confirm/cancel decision), bill_parser_sanity_gate (B5 sanity gate context: matched_sbc_phrases + page_count + blocked_at). Default ''{}'' ensures null-safe reads on existing rows.';

COMMIT;
