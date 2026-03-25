-- Feature flags table — admin-toggleable, env vars as fallback
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by UUID
);

-- Seed defaults (matching feature-flags.ts)
INSERT INTO feature_flags (key, value, description) VALUES
  ('OCR_ENABLED', 'true', 'Master switch for Document AI processing'),
  ('AUTO_PROCESS_ON_UPLOAD', 'false', 'Auto-process documents on upload (false = store only)'),
  ('OCR_MONTHLY_PAGE_LIMIT', '900', 'Monthly page limit for Document AI (free tier = 1000)'),
  ('OCR_DAILY_PAGE_LIMIT', '50', 'Daily page limit for Document AI'),
  ('CLAUDE_EXTRACTION_ENABLED', 'false', 'Enable Claude API for structured SBC extraction'),
  ('UPLOAD_MAX_FILE_SIZE', '20971520', 'Max file size in bytes (20MB)'),
  ('UPLOAD_MAX_PAGES', '20', 'Max pages per PDF'),
  ('UPLOAD_MAX_PER_USER', '10', 'Max documents per user'),
  ('ON_DEMAND_EXTRACTION_ENABLED', 'true', 'Allow on-demand SBC extraction when user matches a plan')
ON CONFLICT (key) DO NOTHING;
