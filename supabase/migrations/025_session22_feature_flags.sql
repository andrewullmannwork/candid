-- Migration 025: Feature flags for Session 22 features
-- All new features start DISABLED. Enable per-user via admin /admin/flags page.

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, target_users, target_percentage)
VALUES
  ('canonical_plans', false, 'Canonical plan matching — dedup uploads into shared plan records with user confirmation', 'users', '{}', 0),
  ('claims_persistence', false, 'Claims persistence — save audit results to claims + claim_line_items tables', 'users', '{}', 0),
  ('dispute_tracking', false, 'Dispute outcome tracking — persist dispute letters and track won/lost/settled status', 'users', '{}', 0)
ON CONFLICT (flag_key) DO NOTHING;
