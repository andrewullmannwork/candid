-- Migration 003: Site copy management table
-- Allows admin users to edit all site text from the admin panel

CREATE TABLE IF NOT EXISTS site_copy (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,           -- e.g. 'hero.title', 'hero.subtitle', 'claim.description'
  value TEXT NOT NULL,                 -- the actual text content
  section TEXT NOT NULL DEFAULT 'general', -- grouping: 'hero', 'features', 'stats', 'footer', etc.
  description TEXT,                    -- admin-facing hint about where this text appears
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast key lookups
CREATE INDEX idx_site_copy_key ON site_copy(key);
CREATE INDEX idx_site_copy_section ON site_copy(section);

-- Auto-update timestamp
CREATE TRIGGER site_copy_updated_at
  BEFORE UPDATE ON site_copy
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS: admins can read/write, public can read
ALTER TABLE site_copy ENABLE ROW LEVEL SECURITY;

CREATE POLICY "site_copy_public_read" ON site_copy
  FOR SELECT USING (true);

CREATE POLICY "site_copy_admin_update" ON site_copy
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

CREATE POLICY "site_copy_admin_insert" ON site_copy
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

CREATE POLICY "site_copy_admin_delete" ON site_copy
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.is_admin = true)
  );

-- Seed default copy values
INSERT INTO site_copy (key, value, section, description) VALUES
  ('hero.title', 'Stop Overpaying for Healthcare', 'hero', 'Main headline on landing page'),
  ('hero.subtitle', 'Candid finds overcharges on your medical bills, uncovers insurance benefits you''re missing, and gives you the tools to fight back. Free audit. Free plan check. No surprises.', 'hero', 'Subheading below the headline'),
  ('hero.cta', 'Join Waitlist', 'hero', 'Waitlist button text'),
  ('hero.success', 'You''re on the list! We''ll be in touch.', 'hero', 'Message after successful waitlist signup'),
  ('features.claim.title', 'Candid Claim', 'features', 'Claim service card title'),
  ('features.claim.description', 'Upload your medical bill or EOB. We find overcharges, duplicate charges, and coding errors — flagging exactly where you may have been overcharged.', 'features', 'Claim service card description'),
  ('features.claim.badge', 'Free', 'features', 'Claim service badge text'),
  ('features.plan.title', 'Candid Plan', 'features', 'Plan service card title'),
  ('features.plan.description', 'Discover insurance benefits you''re not using — from covered therapy sessions and dietitian visits to HSA-eligible body scans and wellness programs.', 'features', 'Plan service card description'),
  ('features.plan.badge', 'Free', 'features', 'Plan service badge text'),
  ('features.case.title', 'Candid Case', 'features', 'Case service card title'),
  ('features.case.description', 'Need to fight a claim? Generate dispute letters with your evidence, or find healthcare billing attorneys in your area. No referral fees — just specialists.', 'features', 'Case service card description'),
  ('features.case.badge', 'Coming Soon', 'features', 'Case service badge text'),
  ('features.care.title', 'Candid Care', 'features', 'Care service card title'),
  ('features.care.description', 'See what healthcare actually costs — what you paid vs. what others paid, which providers bill fairly, and where to find the best value. Powered by real billing data.', 'features', 'Care service card description'),
  ('features.care.badge', 'Coming Soon', 'features', 'Care service badge text'),
  ('stats.heading', 'The Problem is Massive', 'stats', 'Stats section heading'),
  ('stats.1.number', '~80%', 'stats', 'First stat number'),
  ('stats.1.label', 'of medical bills contain errors', 'stats', 'First stat label'),
  ('stats.2.number', '$1,300', 'stats', 'Second stat number'),
  ('stats.2.label', 'average overcharge on large bills', 'stats', 'Second stat label'),
  ('stats.3.number', '<50%', 'stats', 'Third stat number'),
  ('stats.3.label', 'of eligible patients dispute bills', 'stats', 'Third stat label'),
  ('footer.disclaimer', 'Candid is not a healthcare provider, law firm, or insurance company. All outputs are informational and do not constitute legal or medical advice.', 'footer', 'Footer disclaimer text'),
  ('footer.company', 'Candid is an Airgetlam Labs LLC company.', 'footer', 'Footer company attribution');
