-- Migration 048: Seed appeals contact info for top-20 US insurers
--
-- Enables the dispute letter redesign (plan t_dispute_letter_redesign) to
-- auto-populate the "To:" line with the user's insurer's appeals address
-- instead of the hardcoded "Insurance Appeals Department" placeholder.
--
-- Sources: user-verified from insurer member handbooks / websites (2026-04).
-- All entries seeded with appeals_source = 'admin_verified' per Pattern 1
-- (Candid_Data_Patterns.md). Future doc-extracted or user-corrected updates
-- flow through insurer_appeals_proposed_changes (migration 050).
--
-- Depends on migration 047 (adds appeals_* columns + metadata JSONB +
-- appeals_source/confidence/verification_count/last_confirmed_at).
--
-- Idempotent upsert — match on insurer name. If a row doesn't already exist,
-- this inserts it so brand-new insurer catalogs pick up the seed. Supplemental
-- context (parent brand, bcbs_states, legal_name) lives in metadata so the
-- fuzzy-matcher and admin tooling can use it without joining another table.

INSERT INTO insurer_catalog (
  name,
  appeals_address_line_1,
  appeals_city,
  appeals_state,
  appeals_postal_code,
  appeals_phone,
  appeals_updated_at,
  appeals_source,
  appeals_confidence,
  appeals_verification_count,
  appeals_last_confirmed_at,
  metadata
)
VALUES
  ('UnitedHealthcare',                             'PO Box 31364',            'Salt Lake City',  'UT', '84131', '1-800-328-5979', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22"}'),
  ('Aetna',                                        'PO Box 14463',            'Lexington',       'KY', '40512', '1-800-385-4104', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "parent": "CVS Health"}'),
  ('Cigna',                                        'PO Box 188011',           'Chattanooga',     'TN', '37422', '1-800-882-4462', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22"}'),
  ('Humana',                                       'PO Box 14546',            'Lexington',       'KY', '40512', '1-800-448-6262', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22"}'),
  ('Anthem',                                       'PO Box 105568',           'Atlanta',         'GA', '30348', '1-800-331-1476', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "parent": "Elevance Health", "bcbs_states": ["CA","CO","CT","GA","IN","KY","ME","MO","NV","NH","NY","OH","VA","WI"]}'),
  ('Kaiser Permanente',                            'PO Box 7136',             'Pasadena',        'CA', '91109', '1-800-464-4000', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "note": "integrated insurer + provider"}'),
  ('Centene',                                      'PO Box 10341',            'Van Nuys',        'CA', '91410', '1-833-543-3145', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "brands": ["Ambetter"]}'),
  ('Blue Cross Blue Shield of Michigan',           'PO Box 49',               'Detroit',         'MI', '48231', '1-866-309-1719', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22"}'),
  ('Health Care Service Corporation',              'PO Box 3122',             'Naperville',      'IL', '60566', '1-800-538-8833', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "brands": ["BCBS IL","BCBS TX","BCBS NM","BCBS OK","BCBS MT"]}'),
  ('Molina Healthcare',                            'PO Box 22816',            'Long Beach',      'CA', '90801', '1-888-665-4621', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22"}'),
  ('Blue Shield of California',                    'PO Box 5588',             'El Dorado Hills', 'CA', '95762', '1-800-393-6130', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "note": "separate from Anthem BCBS of California"}'),
  ('Independence Blue Cross',                      'PO Box 41820',            'Philadelphia',    'PA', '19101', '1-888-671-5276', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "region": "Philadelphia region"}'),
  ('Highmark',                                     'PO Box 22278',            'Pittsburgh',      'PA', '15222', '1-800-685-5209', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "bcbs_states": ["PA (west)","WV","DE","NY (west)"]}'),
  ('CareFirst BlueCross BlueShield',               'PO Box 14114',            'Lexington',       'KY', '40512', '1-800-244-5685', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "bcbs_states": ["MD","DC","VA (Northern)"]}'),
  ('Premera Blue Cross',                           'PO Box 91102',            'Seattle',         'WA', '98111', '1-800-722-1471', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "bcbs_states": ["WA","AK"]}'),
  ('Regence BlueShield',                           'PO Box 1106',             'Lewiston',        'ID', '83501', '1-888-849-3681', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "bcbs_states": ["WA","OR","UT","ID"]}'),
  ('Horizon Blue Cross Blue Shield of New Jersey', 'PO Box 317',              'Newark',          'NJ', '07105', '1-800-355-2583', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22"}'),
  ('Florida Blue',                                 'PO Box 44197',            'Jacksonville',    'FL', '32231', '1-877-352-2583', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22", "legal_name": "Blue Cross Blue Shield of Florida"}'),
  ('Blue Cross Blue Shield of Massachusetts',      'One Enterprise Drive',    'Quincy',          'MA', '02171', '1-800-814-4371', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22"}'),
  ('BlueCross BlueShield of Tennessee',            '1 Cameron Hill Circle, Suite 0002', 'Chattanooga', 'TN', '37402', '1-800-924-7141', NOW(), 'admin_verified', 1.00, 1, NOW(), '{"seeded_at": "2026-04-22"}')
ON CONFLICT (name) DO UPDATE SET
  appeals_address_line_1     = EXCLUDED.appeals_address_line_1,
  appeals_city               = EXCLUDED.appeals_city,
  appeals_state              = EXCLUDED.appeals_state,
  appeals_postal_code        = EXCLUDED.appeals_postal_code,
  appeals_phone              = EXCLUDED.appeals_phone,
  appeals_updated_at         = EXCLUDED.appeals_updated_at,
  appeals_source             = EXCLUDED.appeals_source,
  appeals_confidence         = EXCLUDED.appeals_confidence,
  appeals_last_confirmed_at  = EXCLUDED.appeals_last_confirmed_at,
  -- verification_count is intentionally NOT reset on conflict — if the row
  -- already accumulated corroborations, preserve them.
  metadata                   = insurer_catalog.metadata || EXCLUDED.metadata;
