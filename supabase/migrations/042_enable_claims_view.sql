-- Migration 042: Enable claims_view + eob_discrepancy_detection feature flags globally
-- The 3-tab Claims/Discrepancies/Disputes UI + ClaimDetail line-item breakdown
-- + three-tier discrepancy detection have been validated end-to-end.
-- Turn on for all users.

UPDATE feature_flag_rules
SET enabled = true, updated_at = now()
WHERE flag_key IN ('claims_view', 'eob_discrepancy_detection');
