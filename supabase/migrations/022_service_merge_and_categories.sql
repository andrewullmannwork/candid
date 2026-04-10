-- Migration 022: Service merge tracking + service_categories reference table
-- Enables: admin service merge (soft deprecation), dynamic category create/delete

-- ── 1. Service merge columns ────────────────────────────────────────────────

ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES service_catalog(id);
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_service_catalog_merged ON service_catalog(merged_into_id) WHERE merged_into_id IS NOT NULL;

-- ── 2. Service categories reference table ───────────────────────────────────

CREATE TABLE IF NOT EXISTS service_categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed with all existing categories (matches current CHECK constraint values + extras)
INSERT INTO service_categories (id, label, sort_order) VALUES
  ('office_visit', 'Office Visits', 1),
  ('emergency', 'Emergency', 2),
  ('hospital', 'Hospital', 3),
  ('imaging', 'Imaging', 4),
  ('lab', 'Lab & Testing', 5),
  ('rx', 'Prescriptions', 6),
  ('therapy', 'Therapy & Rehab', 7),
  ('mental_health', 'Mental Health', 8),
  ('maternity', 'Maternity', 9),
  ('dme', 'Equipment & Supplies', 10),
  ('preventive', 'Preventive Care', 11),
  ('long_term_care', 'Long-Term Care', 12),
  ('general', 'General', 13),
  ('other', 'Other / Uncategorized', 99)
ON CONFLICT DO NOTHING;

-- ── 3. Replace CHECK constraint with FK to service_categories ───────────────

-- Drop the old CHECK constraint (name inferred from pg convention)
ALTER TABLE service_catalog DROP CONSTRAINT IF EXISTS service_catalog_category_check;

-- Add FK so category values must exist in service_categories
ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_category_fk
  FOREIGN KEY (category) REFERENCES service_categories(id);

-- ── 4. Add service_categories to admin query whitelist note ─────────────────
-- (Must also add 'service_categories' to ALLOWED_TABLES in /api/admin/query)
