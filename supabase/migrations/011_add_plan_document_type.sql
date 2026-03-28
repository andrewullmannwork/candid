-- Migration 011: Add 'plan_document' to doc_type enum
-- Allows users to upload full plan certificates (50-90 pages)

ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'plan_document';
