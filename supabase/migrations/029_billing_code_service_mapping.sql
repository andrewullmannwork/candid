-- Migration 029: Billing Code Service Mapping (T0.5)
-- Adds feature flag for Haiku-based billed_description → service_slug mapping
-- during claims persistence. No schema changes — claim_line_items already has
-- billing_code, billing_code_type, and service_slug columns (migration 019).

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, target_users, target_percentage)
VALUES (
  'billing_code_service_mapping',
  false,
  'Map bill line item descriptions to service_slug via Haiku during claims persistence',
  'users',
  '{}',
  0
)
ON CONFLICT (flag_key) DO NOTHING;
