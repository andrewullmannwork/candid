-- Migration 027: Smart Extraction Skip (Document Dedup)
-- Enables skipping Haiku extraction for plans that already have stable canonical data.

-- File hash for exact duplicate detection
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash) WHERE file_hash IS NOT NULL;

-- Extraction tracking on canonical plans
ALTER TABLE canonical_plans ADD COLUMN IF NOT EXISTS extraction_count INTEGER DEFAULT 0;
ALTER TABLE canonical_plans ADD COLUMN IF NOT EXISTS last_extraction_at TIMESTAMPTZ;
ALTER TABLE canonical_plans ADD COLUMN IF NOT EXISTS extraction_stable BOOLEAN DEFAULT FALSE;

-- Extraction audit log (also serves T0.4 retry tracking later)
CREATE TABLE IF NOT EXISTS document_extraction_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  canonical_plan_id UUID REFERENCES canonical_plans(id),
  file_hash TEXT,
  plan_identifiers JSONB,
  action TEXT NOT NULL CHECK (action IN (
    'full_extraction', 'skipped_canonical_stable', 'skipped_exact_match'
  )),
  services_extracted INTEGER DEFAULT 0,
  new_services_found INTEGER DEFAULT 0,
  skip_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_del_canonical ON document_extraction_log(canonical_plan_id);
CREATE INDEX IF NOT EXISTS idx_del_document ON document_extraction_log(document_id);

-- RLS for document_extraction_log
ALTER TABLE document_extraction_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY del_select_own ON document_extraction_log FOR SELECT USING (user_id = auth.uid());
CREATE POLICY del_admin_select ON document_extraction_log FOR SELECT USING (
  EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND is_admin = true)
);

-- Feature flag (disabled by default)
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type)
VALUES ('document_dedup', false, 'Smart extraction skip for known plans', 'global')
ON CONFLICT (flag_key) DO NOTHING;
