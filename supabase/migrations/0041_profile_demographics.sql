-- 004: Add demographics and dependents to profiles
-- Supports age/sex-specific benefit recommendations and family plan tracking

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS sex TEXT CHECK (sex IN ('male', 'female', 'prefer_not_to_say')),
  ADD COLUMN IF NOT EXISTS dependents JSONB DEFAULT '[]'::jsonb;

-- dependents schema (enforced at application level):
-- [{ name, relationship, date_of_birth, sex, on_same_plan }]

COMMENT ON COLUMN profiles.date_of_birth IS 'Used for age-specific benefit recommendations (e.g. colonoscopy at 45+)';
COMMENT ON COLUMN profiles.sex IS 'Sex assigned at birth — used for sex-specific screening recommendations';
COMMENT ON COLUMN profiles.dependents IS 'JSON array of family members for family benefit recommendations';
