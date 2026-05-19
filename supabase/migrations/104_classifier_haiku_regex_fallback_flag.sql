-- S94 B5 — classifier_haiku_regex_fallback_v1 feature flag + admin-tunable knobs.
--
-- Background: S94 B1 Stage 4 dev testing surfaced a doc-type resolver miss:
-- an SBC PDF uploaded via the "Bill" card produced a spurious $93,155 claim
-- because (a) Haiku classifier's `JSON.parse` crashed on a malformed response,
-- (b) the catch block silently fell back to the user's pick instead of running
-- the regex classifier on full OCR, and (c) the bill parser then hallucinated
-- CPT codes from page numbers and HHS office addresses on the SBC pages.
--
-- This flag gates three new defenses, all opt-in and admin-tunable:
--   (1) When Haiku classification fails (network, JSON parse, etc.), fall back
--       to the regex classifier on FULL OCR text rather than the user's pick.
--   (2) Before the bill parser fires, sanity-check the document: if it has too
--       many pages OR matches too many SBC-specific phrases, refuse to parse
--       and mark rejected_doc_type_mismatch.
--   (3) When the regex quick-classifier disagrees with the user's pick at
--       moderate confidence (above confirmation_regex_threshold but below the
--       Pattern P hard-override threshold), halt the upload pipeline and
--       surface a confirmation modal asking the user to choose.
--
-- Knobs:
--   - haiku_failure_fallback ('regex' | 'user_pick'): which to trust when
--     Haiku is unavailable. Default 'regex'.
--   - sanity_gate_enabled (bool): turn the bill-parser sanity gate on/off.
--     Default true.
--   - sanity_gate_min_pages (int): pageCount >= this triggers refusal when
--     effective type is bill. Default 10.
--   - sanity_gate_sbc_phrase_count (int): SBC-phrase matches >= this triggers
--     refusal when effective type is bill. Default 2.
--   - confirmation_ui_enabled (bool): turn the disagreement modal on/off.
--     Default true.
--   - confirmation_regex_threshold (float 0-1): regex confidence at or above
--     which a disagreement triggers the confirmation modal (vs silent
--     user-pick-wins). Default 0.5.
--
-- Default `enabled=false` — flip ON via /admin/upload-settings (S94 B5 admin
-- UI extension) after migration apply + local Chrome MCP validation. Mirrors
-- mig 075/099 INSERT shape (target_type='global' + config JSONB; flag_key
-- UNIQUE).

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'classifier_haiku_regex_fallback_v1',
  false,
  'S94 B5. Three defenses against doc-type resolver misses uncovered during S94 B1 Stage 4 testing. (1) Haiku failure falls back to regex classifier on full OCR (haiku_failure_fallback). (2) Bill parser refuses on suspected SBC content (sanity_gate_enabled / sanity_gate_min_pages / sanity_gate_sbc_phrase_count). (3) Moderate-confidence regex/user disagreement halts pipeline at awaiting_doc_type_confirmation step (confirmation_ui_enabled / confirmation_regex_threshold). Default disabled — flip ON via /admin/upload-settings after local validation.',
  'global',
  '{"haiku_failure_fallback":"regex","sanity_gate_enabled":true,"sanity_gate_min_pages":10,"sanity_gate_sbc_phrase_count":2,"confirmation_ui_enabled":true,"confirmation_regex_threshold":0.5}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
