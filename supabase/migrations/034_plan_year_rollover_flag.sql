-- Migration 034: Feature flag for plan year rollover (T1.7)
-- Gates: year rollover prompt on upload, plan year badge, dashboard deductible banner, plan history section.
-- Backend detection still runs (stores year_rollover data harmlessly); this flag controls UI display only.

INSERT INTO feature_flag_rules (flag_key, scope, enabled, description)
VALUES ('plan_year_rollover', 'global', false, 'Enable plan year rollover detection UI, plan year badge, deductible reset banner, and plan history section')
ON CONFLICT (flag_key) DO NOTHING;
