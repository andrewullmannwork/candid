-- Migration 078 — documents.purpose column
--
-- Lets the upload pipeline distinguish "primary" plan uploads (which deactivate
-- prior active plans + set the new doc as the user's active plan) from
-- "comparison" uploads via /compare (which must NEVER overwrite the user's
-- existing primary plan, but should still feed the canonical-corroboration
-- flywheel via Pattern 1 #14 since they're real verified-user-uploaded data).
--
-- Default 'primary' preserves existing /upload behavior. Comparison uploads
-- via /compare set 'comparison' explicitly. Any future purposes (e.g.,
-- 'shared-with-doctor', 'audit-only') extend the CHECK constraint here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS guards re-runs.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS purpose text DEFAULT 'primary';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'documents_purpose_check'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_purpose_check
      CHECK (purpose IN ('primary', 'comparison'));
  END IF;
END$$;

COMMENT ON COLUMN documents.purpose IS
  'Why the document was uploaded. ''primary'' = user is uploading their actual plan (default; overwrites prior active plan). ''comparison'' = user is uploading a plan to consider via /compare (does NOT overwrite the user''s primary plan; still feeds canonical corroboration). Mig 078.';
