-- S78 (Session 78) — async ingestion UX feature flag.
--
-- Gates the large-doc async upload experience: PDF page count > 30 triggers
-- an extended PlayfulParsingScreen splash with personalized copy + duration
-- estimate + "Continue browsing" CTA; the user is free to navigate away while
-- the parse runs in the background (existing QStash process-chunk pipeline);
-- when status transitions to 'processed' the backend fires a Resend
-- parse-complete email (idempotent via parse-complete:{documentId} key); and
-- a closable banner appears on every authed page polling
-- /api/documents/recent every 30s.
--
-- Sub-30-page PDFs and all non-PDF uploads (HEIC, JPEG cards) continue using
-- the existing sync PlayfulParsingScreen — they finish in ≤2 minutes and the
-- async surfaces would be more friction than value.
--
-- Default OFF in dev — flip ON only after dev-server smoke confirms both
-- large-doc and small-doc paths render correctly. Same for PROD post-merge.
--
-- Mirrors mig 075's INSERT shape (target_type + config JSONB; flag_key UNIQUE).

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'async_ingestion_ux_v1',
  false,
  'S78 (Session 78). Async ingestion UX for large plan documents. When OFF, all uploads use the existing sync PlayfulParsingScreen flow (client waits on parse via polling). When ON, PDF uploads with pageCount > 30 trigger the new extended splash + Resend parse-complete email + closable banner on every authed page (10-min window or user dismissal). Backend pipeline (QStash + process-chunk) is unchanged in both modes. Page-count gate matches LARGE_DOC_PAGE_THRESHOLD constant in onboarding-emails.ts + /api/documents/recent. Flip global ON after dev-smoke verifies both small + large doc paths render correctly.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
