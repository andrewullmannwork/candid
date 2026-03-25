-- Add phone column to profiles table
-- The API and frontend already handle phone data, but the column was never created.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT;
