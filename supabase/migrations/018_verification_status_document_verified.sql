-- Add document_verified to verification_status check constraint
ALTER TABLE insurance_plans DROP CONSTRAINT IF EXISTS insurance_plans_verification_status_check;
ALTER TABLE insurance_plans ADD CONSTRAINT insurance_plans_verification_status_check
  CHECK (verification_status IN ('unverified', 'user_confirmed', 'cms_matched', 'multi_user_verified', 'document_verified'));
