-- Migration 047: Insurer appeals contact info + Pattern 1 provenance columns
--
-- Adds columns to `insurer_catalog` so dispute letters can auto-populate the
-- "To:" line with the user's insurer's appeals address (rather than the
-- hardcoded "Insurance Appeals Department" placeholder).
--
-- Implements Pattern 1 (admin-seeded → crowdsourced → admin review) from
-- Candid_Data_Patterns.md. The provenance columns (source/confidence/
-- verification_count/last_confirmed_at) let the dispute-letter resolver gate
-- rendering and trigger stale-confirmation prompts per Pattern 1, section
-- "Stale-detection thresholds" (180 days for appeals addresses).
--
-- Migration 048 (already authored) seeds the top-20 US insurers. It depends
-- on the columns and `metadata` JSONB added here.
--
-- Additive only — no DROPs, no type changes. Safe to apply in any order
-- relative to other 04x work.

-- ── Metadata JSONB ─────────────────────────────────────────────────────────
-- Referenced by migration 048 for `admin_verified` flags + optional
-- `parent` / `brands` / `bcbs_states` context. Default to empty object so
-- existing rows continue to read as `{}`.

ALTER TABLE insurer_catalog
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Appeals contact fields ─────────────────────────────────────────────────
-- Structured columns for the common case (US postal address + phone).
-- Nullable so admin-seeded data can ship partial rows without backfill.

ALTER TABLE insurer_catalog
  ADD COLUMN IF NOT EXISTS appeals_address_line_1 TEXT,
  ADD COLUMN IF NOT EXISTS appeals_address_line_2 TEXT,
  ADD COLUMN IF NOT EXISTS appeals_city TEXT,
  ADD COLUMN IF NOT EXISTS appeals_state TEXT,
  ADD COLUMN IF NOT EXISTS appeals_postal_code TEXT,
  ADD COLUMN IF NOT EXISTS appeals_phone TEXT,
  ADD COLUMN IF NOT EXISTS appeals_updated_at TIMESTAMPTZ;

-- JSONB fallback for edge cases the structured columns don't cover
-- (international addresses, multi-channel contacts, TTY lines, portal URLs).
-- Admin tooling can write here without a schema change per insurer.

ALTER TABLE insurer_catalog
  ADD COLUMN IF NOT EXISTS appeals_contact JSONB;

-- ── Pattern 1 provenance columns ───────────────────────────────────────────
-- source:             how this row got here (gates auto-overwrite rules)
-- confidence:         0-1; Haiku-derived on doc extraction, 1.0 on admin
-- verification_count: # of corroborating signals (doc extractions + user confirms)
-- last_confirmed_at:  last time a user/doc corroborated this row
--                     (drives the 180-day stale prompt on the letter page)

ALTER TABLE insurer_catalog
  ADD COLUMN IF NOT EXISTS appeals_source TEXT
    CHECK (appeals_source IN ('admin_verified','doc_extraction','user_correction','unknown')),
  ADD COLUMN IF NOT EXISTS appeals_confidence NUMERIC(3,2)
    CHECK (appeals_confidence IS NULL OR (appeals_confidence >= 0 AND appeals_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS appeals_verification_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS appeals_last_confirmed_at TIMESTAMPTZ;

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Stale-detection queries scan insurers with expiring `last_confirmed_at`.
-- Admin dashboard "stale addresses" card and resolver pre-fetch use this.

CREATE INDEX IF NOT EXISTS idx_insurer_catalog_appeals_last_confirmed
  ON insurer_catalog(appeals_last_confirmed_at)
  WHERE appeals_last_confirmed_at IS NOT NULL;

-- Admin dashboard "coverage gaps" query: insurers with NULL appeals data.

CREATE INDEX IF NOT EXISTS idx_insurer_catalog_appeals_missing
  ON insurer_catalog(id)
  WHERE appeals_address_line_1 IS NULL;

-- ── Column comments (for future schema readers) ────────────────────────────

COMMENT ON COLUMN insurer_catalog.appeals_address_line_1 IS
  'Appeals/grievances PO Box or street address, line 1. Source tracked via appeals_source.';
COMMENT ON COLUMN insurer_catalog.appeals_contact IS
  'Fallback JSONB for appeals contact data that doesn''t fit the structured columns (international addresses, portal URLs, TTY lines).';
COMMENT ON COLUMN insurer_catalog.appeals_source IS
  'Pattern 1 provenance. admin_verified = golden copy (never silently overwritten). doc_extraction = Haiku-parsed SBC. user_correction = user-submitted via verify strip. unknown = legacy seed.';
COMMENT ON COLUMN insurer_catalog.appeals_verification_count IS
  'Pattern 1 corroboration count. Bumped by every matching doc extraction or user confirmation. Gates crowdsourced corroboration thresholds (doc=3, user=5 per Candid_Data_Patterns.md).';
COMMENT ON COLUMN insurer_catalog.appeals_last_confirmed_at IS
  'Pattern 1 stale-detection. When NOW() - this > 180d, dispute letter page shows "verify this address" strip. See Candid_Data_Patterns.md for thresholds.';
