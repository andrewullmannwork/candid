-- F.0 Phase-1 fixture seed: the "existing 48k rows" (inserted PRE-mig-165, so no aligned
-- columns + no align trigger yet — the confidence trigger sets confidence from provenance MIN).
-- Covers the real-data shapes verified S207.

INSERT INTO canonical_plan_services
  (service_slug, copay, coinsurance, deductible_applies, is_covered, requires_prior_auth, out_copay, field_provenance) VALUES
  -- A: full attestation (all 5 in-net legacy keys) -> confidence MIN = 0.9
  ('row_a_full', 20, 0.2, true, true, true, NULL,
   '{"copay":{"value":20,"confidence":0.9},"coinsurance":{"value":0.2,"confidence":0.9},"deductible_applies":{"value":true,"confidence":0.9},"is_covered":{"value":true,"confidence":0.9},"requires_prior_auth":{"value":true,"confidence":0.9}}'),
  -- B: the 42,194-row shape — requires_prior_auth typed (DEFAULT false) but NO provenance key
  ('row_b_reqpa_default', 0, NULL, true, true, false, NULL,
   '{"copay":{"value":0,"confidence":0.9},"is_covered":{"value":true,"confidence":0.9}}'),
  -- C: mixed confidences -> MIN = 0.7 (proves twins don't shift MIN)
  ('row_c_min', 10, NULL, true, true, false, NULL,
   '{"copay":{"value":10,"confidence":0.9},"is_covered":{"value":true,"confidence":0.7}}'),
  -- D: out_* present -> must stay untouched; in_copay twin must come from copay(15), not out_copay(40)
  ('row_d_out', 15, NULL, true, true, false, 40,
   '{"copay":{"value":15,"confidence":0.9},"out_copay":{"value":40,"confidence":0.8}}'),
  -- E: empty provenance -> typed copied, no twins, confidence untouched (DEFAULT 0.5)
  ('row_e_emptyprov', 5, NULL, true, true, false, NULL, '{}');

-- pre-align confidence snapshot (the trigger-safety oracle)
CREATE TABLE _pre_conf AS SELECT id, service_slug, confidence FROM canonical_plan_services;
