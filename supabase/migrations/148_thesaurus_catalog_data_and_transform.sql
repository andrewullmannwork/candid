-- Migration 148: Service Thesaurus — catalog data + apply_promotion_event RPC reconciliation
--                + deterministic lossless transform of cold-start rows (Pattern S, Phase 0.5)
--
-- DEPENDS ON mig 147 (place_of_service + component columns + 4-col unique on canonical_plan_services;
-- service_indications + concept_indications tables). Apply 147 THEN 148.
--
-- SHIPS WITH the 4-col onConflict fix at canonical-match.ts:646 + wire-plan-catalog-to-canonical.ts:411
-- + promotion-event.ts:80 / commit-and-evaluate.ts param-plumb. PRE-LAUNCH, no users.
--
-- SoT: Candid_Data_Patterns "Pattern S" + Hard Rule #17 · runbook §D/§E · news-consolidation.md.
-- Transform = lossless RENAME via the merge pattern (insert new slug → repoint canonical rows →
-- deprecate old slug via merged_into_id). canonical_plan_services.service_slug is NOT an enforced FK,
-- so the row repoint is free; billing_code_mappings.service_slug IS an FK so old slug rows are kept
-- (deprecated, never deleted). Collapsing rows are distinguished by the new place_of_service/component
-- key (verified: only specialty tier4/5 collided → tier5 routed to its own is_a slug).

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- PART 1 — apply_promotion_event RPC reconciliation (4-col key + critical-pass refinements)
-- ════════════════════════════════════════════════════════════════════════════

-- 1a. Event-log forensic trail: per-variant distinguishability (critical-pass gap #4).
ALTER TABLE canonical_promotion_events
  ADD COLUMN IF NOT EXISTS place_of_service TEXT,
  ADD COLUMN IF NOT EXISTS component TEXT;

-- 1b. CREATE OR REPLACE with: +p_place_of_service/+p_component (COALESCE'd), delimited lock key,
--     4-col FOR UPDATE read + INSERT + ON CONFLICT. canonical_plans branch UNCHANGED.
-- DROP the old 8-param signature FIRST — CREATE OR REPLACE with +2 params creates a new OVERLOAD,
-- which would leave the old (2-col ON CONFLICT) function live + broken post-rekey. The +2 params
-- default, so existing 8-arg callers resolve cleanly to the new 10-param function.
DROP FUNCTION IF EXISTS apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT);
CREATE OR REPLACE FUNCTION apply_promotion_event(
  p_canonical_plan_id UUID,
  p_service_slug TEXT,
  p_field_name TEXT,
  p_corroborated_value JSONB,
  p_sources JSONB,
  p_fire_source TEXT,
  p_actor_user_id UUID DEFAULT NULL,
  p_force_event_type TEXT DEFAULT NULL,
  p_place_of_service TEXT DEFAULT 'any',
  p_component TEXT DEFAULT 'global'
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock_key BIGINT;
  v_existing_provenance JSONB;
  v_existing_field_entry JSONB;
  v_current_confidence NUMERIC;
  v_current_corroborator_count INT;
  v_existing_sources JSONB;
  v_merged_sources JSONB;
  v_new_field_entry JSONB;
  v_event_id UUID;
  v_event_type TEXT;
  v_total_corroborator_count INT;
  v_sources_added INT;
  v_target_table TEXT;
  v_max_k INT;
  v_pos TEXT := COALESCE(p_place_of_service, 'any');       -- null-safety (TS undefined->null)
  v_component TEXT := COALESCE(p_component, 'global');
BEGIN
  IF p_canonical_plan_id IS NULL OR p_field_name IS NULL OR p_corroborated_value IS NULL THEN
    RAISE EXCEPTION 'apply_promotion_event: canonical_plan_id, field_name, corroborated_value are required';
  END IF;
  IF p_force_event_type IS NOT NULL
     AND p_force_event_type NOT IN ('first_promotion', 'corroboration_added', 'value_corrected_via_challenge', 'admin_override') THEN
    RAISE EXCEPTION 'apply_promotion_event: invalid p_force_event_type = %', p_force_event_type;
  END IF;

  v_target_table := CASE WHEN p_service_slug IS NULL THEN 'canonical_plans' ELSE 'canonical_plan_services' END;

  SELECT (config->>'sources_array_max_k')::INT INTO v_max_k
  FROM feature_flag_rules WHERE flag_key = 'canonical_promotion_event_v1';
  v_max_k := COALESCE(v_max_k, 5);

  -- Advisory lock — delimited (restores the mig-068 ':' separators mig 129 dropped) + pos/component.
  v_lock_key := hashtextextended(
    'cpe:' || p_canonical_plan_id::TEXT || ':' || COALESCE(p_service_slug, '_')
      || ':' || v_pos || ':' || v_component || ':' || p_field_name, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF v_target_table = 'canonical_plans' THEN
    SELECT field_provenance INTO v_existing_provenance
    FROM canonical_plans WHERE id = p_canonical_plan_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'apply_promotion_event: canonical_plans row % not found', p_canonical_plan_id;
    END IF;
  ELSE
    SELECT field_provenance INTO v_existing_provenance
    FROM canonical_plan_services
    WHERE canonical_plan_id = p_canonical_plan_id AND service_slug = p_service_slug
      AND place_of_service = v_pos AND component = v_component
    FOR UPDATE;  -- 4-col target; may not exist yet (first promotion → INSERT below)
  END IF;

  v_existing_field_entry := COALESCE(v_existing_provenance->p_field_name, '{}'::jsonb);
  v_current_confidence := COALESCE((v_existing_field_entry->>'confidence')::NUMERIC, 0);
  v_current_corroborator_count := COALESCE((v_existing_field_entry->>'corroborator_count')::INT, 0);
  v_existing_sources := COALESCE(v_existing_field_entry->'sources', '[]'::jsonb);

  IF p_force_event_type IS NOT NULL THEN
    v_event_type := p_force_event_type;
  ELSIF COALESCE(v_current_confidence, 0) < 0.9 THEN
    v_event_type := 'first_promotion';
  ELSE
    v_event_type := 'corroboration_added';
  END IF;

  WITH all_hashes AS (
    SELECT DISTINCT (entry->>'user_id_hash') AS h
    FROM jsonb_array_elements(v_existing_sources || COALESCE(p_sources, '[]'::jsonb)) AS entries(entry)
  )
  SELECT COUNT(*) INTO v_total_corroborator_count FROM all_hashes;

  WITH unioned AS (
    SELECT DISTINCT ON (entry->>'user_id_hash') entry
    FROM jsonb_array_elements(v_existing_sources || COALESCE(p_sources, '[]'::jsonb)) AS entries(entry)
    ORDER BY entry->>'user_id_hash', (entry->>'recorded_at')::TIMESTAMPTZ NULLS LAST
  ),
  ordered AS (
    SELECT entry FROM unioned ORDER BY (entry->>'recorded_at')::TIMESTAMPTZ NULLS LAST LIMIT v_max_k
  )
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO v_merged_sources FROM ordered;

  v_sources_added := jsonb_array_length(v_merged_sources) - jsonb_array_length(v_existing_sources);
  IF v_sources_added < 0 THEN v_sources_added := 0; END IF;

  v_new_field_entry := jsonb_build_object(
    'value', p_corroborated_value, 'confidence', 0.9,
    'source', CASE WHEN v_event_type = 'admin_override' THEN 'admin_attested'
                   WHEN v_event_type = 'value_corrected_via_challenge' THEN 'challenge_resolution'
                   ELSE 'multi_source_corroboration' END,
    'corroborator_count', v_total_corroborator_count, 'sources', v_merged_sources, 'promoted_at', now());

  v_event_id := gen_random_uuid();

  IF v_target_table = 'canonical_plans' THEN
    -- UNCHANGED from mig 129 (plan-identity typed-col sync).
    UPDATE canonical_plans SET
      field_provenance = jsonb_set(COALESCE(field_provenance, '{}'::jsonb), ARRAY[p_field_name], v_new_field_entry, true),
      deductible_individual = CASE WHEN p_field_name='in_deductible_individual' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE deductible_individual END,
      deductible_family = CASE WHEN p_field_name='in_deductible_family' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE deductible_family END,
      oop_max_individual = CASE WHEN p_field_name='in_oop_max_individual' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE oop_max_individual END,
      oop_max_family = CASE WHEN p_field_name='in_oop_max_family' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE oop_max_family END,
      plan_name = CASE WHEN p_field_name='plan_name' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE plan_name END,
      plan_year = CASE WHEN p_field_name='plan_year' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INT ELSE plan_year END,
      plan_type = CASE WHEN p_field_name='plan_type' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE plan_type END,
      metal_level = CASE WHEN p_field_name='metal_level' AND jsonb_typeof(p_corroborated_value)='string' THEN (p_corroborated_value)#>>'{}' ELSE metal_level END,
      updated_at = now()
    WHERE id = p_canonical_plan_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'apply_promotion_event: canonical_plans row % not found (concurrent DELETE?)', p_canonical_plan_id; END IF;
  ELSE
    INSERT INTO canonical_plan_services (
      canonical_plan_id, service_slug, place_of_service, component,
      confidence, source, field_provenance, copay, coinsurance, deductible_applies, is_covered, requires_prior_auth)
    VALUES (
      p_canonical_plan_id, p_service_slug, v_pos, v_component,
      0.9, CASE WHEN v_event_type='admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      jsonb_build_object(p_field_name, v_new_field_entry),
      CASE WHEN p_field_name='copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE NULL END,
      CASE WHEN p_field_name='coinsurance' AND jsonb_typeof(p_corroborated_value)='number'
        THEN LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC, CASE WHEN ((p_corroborated_value)::TEXT::NUMERIC)>1 THEN ((p_corroborated_value)::TEXT::NUMERIC)/100 ELSE (p_corroborated_value)::TEXT::NUMERIC END)) ELSE NULL END,
      CASE WHEN p_field_name='deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='is_covered' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='requires_prior_auth' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END)
    ON CONFLICT (canonical_plan_id, service_slug, place_of_service, component) DO UPDATE SET
      field_provenance = jsonb_set(COALESCE(canonical_plan_services.field_provenance, '{}'::jsonb), ARRAY[p_field_name], v_new_field_entry, true),
      confidence = GREATEST(canonical_plan_services.confidence, 0.9),
      source = CASE WHEN v_event_type='admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      copay = CASE WHEN p_field_name='copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE canonical_plan_services.copay END,
      coinsurance = CASE WHEN p_field_name='coinsurance' AND jsonb_typeof(p_corroborated_value)='number'
        THEN LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC, CASE WHEN ((p_corroborated_value)::TEXT::NUMERIC)>1 THEN ((p_corroborated_value)::TEXT::NUMERIC)/100 ELSE (p_corroborated_value)::TEXT::NUMERIC END)) ELSE canonical_plan_services.coinsurance END,
      deductible_applies = CASE WHEN p_field_name='deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.deductible_applies END,
      is_covered = CASE WHEN p_field_name='is_covered' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.is_covered END,
      requires_prior_auth = CASE WHEN p_field_name='requires_prior_auth' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.requires_prior_auth END,
      updated_at = now();
  END IF;

  INSERT INTO canonical_promotion_events (
    id, canonical_plan_id, service_slug, place_of_service, component, field_name,
    event_type, fire_source, corroborator_count, sources_count, corroborated_value, actor_user_id, fired_at)
  VALUES (
    v_event_id, p_canonical_plan_id, p_service_slug,
    CASE WHEN p_service_slug IS NULL THEN NULL ELSE v_pos END,
    CASE WHEN p_service_slug IS NULL THEN NULL ELSE v_component END,
    p_field_name, v_event_type, p_fire_source, v_total_corroborator_count, v_sources_added,
    p_corroborated_value, p_actor_user_id, now());

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION apply_promotion_event(UUID, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, TEXT, TEXT) IS
  'S167 Thesaurus (mig 148): extends mig 129 with place_of_service + component targeting on the canonical_plan_services branch — 4-col advisory lock (delimited) + FOR UPDATE read + INSERT + ON CONFLICT, COALESCE-defaulted to (any, global) for back-compat. canonical_plans branch unchanged. Event log now records pos/component. The corroboration EVALUATOR (evaluate_pattern1_corroboration) + plan_covered_services.component remain (canonical, slug)-keyed — pos/component-correct corroboration completes in Phase 1 (parser produces pos/component); inert pre-launch (no users).';

-- ════════════════════════════════════════════════════════════════════════════
-- PART 2 — Reference data: indications, categories, concepts/slugs, is_a, concept_indications
-- ════════════════════════════════════════════════════════════════════════════

-- 2a0. Widen the category CHECK to admit the 6 new categories (mig 022 added an FK to
--      service_categories but the auto-named CHECK constraint is STILL active + tighter).
--      Must run before any service_catalog category write (2d INSERT + 3a recategorize).
ALTER TABLE service_catalog DROP CONSTRAINT IF EXISTS service_catalog_category_check;
ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_category_check
  CHECK (category IN (
    'office_visit','emergency','hospital','imaging','lab','rx','therapy','mental_health',
    'maternity','dme','preventive','other','long_term_care',
    'dental','vision','surgery','hospitalization','dialysis','family_planning'));

-- 2a. Indication lookup (Decision 2).
INSERT INTO service_indications (id, label, sort_order) VALUES
  ('sexual_dysfunction','Sexual Dysfunction',10),
  ('medically_necessary','Medically Necessary',20),
  ('weight_loss','Weight Loss',30)
ON CONFLICT (id) DO NOTHING;

-- 2b. New categories (FK target for service_catalog.category — mig 022 replaced the CHECK with this FK).
INSERT INTO service_categories (id, label, sort_order) VALUES
  ('dental','Dental',100),('vision','Vision',110),('surgery','Surgery',120),
  ('hospitalization','Hospitalization',130),('dialysis','Dialysis',140),('family_planning','Family Planning',150)
ON CONFLICT (id) DO NOTHING;

-- 2c. New concepts (vocabulary CANDID; class/domain 'service' per existing seed shape).
INSERT INTO concepts (vocabulary_id, concept_code, concept_name, concept_class, domain) VALUES
  -- rx role-anchored (D1)
  ('CANDID','generic_rx','Generic Drugs','service','service'),
  ('CANDID','preferred_brand_rx','Preferred Brand Drugs','service','service'),
  ('CANDID','non_preferred_brand_rx','Non-Preferred Brand Drugs','service','service'),
  ('CANDID','specialty_rx','Specialty Drugs','service','service'),
  ('CANDID','non_preferred_specialty_rx','Non-Preferred Specialty Drugs','service','service'),
  ('CANDID','prescription_drugs','Prescription Drugs (catch-all)','service','service'),
  -- hospital/surgery (D2/D3)
  ('CANDID','hospital_admission','Hospital Admission','service','service'),
  ('CANDID','hospital_outpatient','Hospital Outpatient','service','service'),
  ('CANDID','observation','Observation Stay','service','service'),
  ('CANDID','surgery','Surgery','service','service'),
  -- News (consolidated)
  ('CANDID','abortion','Abortion','service','service'),
  ('CANDID','sterilization','Sterilization','service','service'),
  ('CANDID','tubal_ligation','Tubal Ligation','service','service'),
  ('CANDID','vasectomy','Vasectomy','service','service'),
  ('CANDID','contraceptives','Contraceptives','service','service'),
  ('CANDID','family_planning_counseling','Family Planning Counseling','service','service'),
  ('CANDID','allergy_injection','Allergy Serum / Injection','service','service'),
  ('CANDID','medical_foods','Medical Foods / Formulas','service','service'),
  ('CANDID','diabetes_education','Diabetes Self-Management Education','service','service'),
  ('CANDID','doula_services','Doula Services','service','service'),
  ('CANDID','transplant','Transplant Services','service','service'),
  ('CANDID','dialysis','Dialysis','service','service'),
  ('CANDID','medical_eye_care','Medical Eye Care (non-routine)','service','service'),
  ('CANDID','covid_services','COVID-19 Tests & Therapeutics','service','service')
ON CONFLICT (vocabulary_id, concept_code) DO NOTHING;

-- 2d. New service_catalog slugs (link concept_id by concept_code=slug; canonical_for_concept=TRUE,
--     one per new concept so the mig-103 enforce_canonical_per_concept trigger is satisfied).
INSERT INTO service_catalog (slug, name, category, description, is_preventive_eligible, concept_id, canonical_for_concept, proposal_state)
SELECT v.slug, v.name, v.category, v.descr, v.prev, c.id, TRUE, 'canonical'
FROM (VALUES
  ('generic_rx','Generic Drugs','rx','Generic prescription drugs (role-anchored; tier/channel are modifiers)',false),
  ('preferred_brand_rx','Preferred Brand Drugs','rx','Preferred brand prescription drugs',false),
  ('non_preferred_brand_rx','Non-Preferred Brand Drugs','rx','Non-preferred brand prescription drugs',false),
  ('specialty_rx','Specialty Drugs','rx','Specialty prescription drugs',false),
  ('non_preferred_specialty_rx','Non-Preferred Specialty Drugs','rx','Non-preferred specialty drugs (was tier 5)',false),
  ('prescription_drugs','Prescription Drugs','rx','Prescription drugs (catch-all when role unspecified)',false),
  ('hospital_admission','Hospital Admission','hospitalization','Inpatient hospital admission',false),
  ('hospital_outpatient','Hospital Outpatient','hospitalization','Outpatient hospital services / facility fee',false),
  ('observation','Observation Stay','hospitalization','Observation status stay',false),
  ('surgery','Surgery','surgery','Surgery (pure service; setting=place_of_service, facility/professional=component)',false),
  ('abortion','Abortion','family_planning','Abortion services (surgical or medication)',false),
  ('sterilization','Sterilization','family_planning','Sterilization procedures (parent)',false),
  ('tubal_ligation','Tubal Ligation','family_planning','Tubal ligation (female sterilization)',false),
  ('vasectomy','Vasectomy','family_planning','Vasectomy (male sterilization)',false),
  ('contraceptives','Contraceptives','family_planning','Contraceptive drugs, devices, IUDs, implants',false),
  ('family_planning_counseling','Family Planning Counseling','family_planning','Family planning counseling / education',false),
  ('allergy_injection','Allergy Serum / Injection','rx','Allergy serum billed separately from a visit',false),
  ('medical_foods','Medical Foods / Formulas','dme','Enteral/metabolic formulas, special foods (route in coverage_rules per Rule #9)',false),
  ('diabetes_education','Diabetes Self-Management Education','therapy','Outpatient diabetes self-management education',false),
  ('doula_services','Doula Services','maternity','Doula support during labor and delivery',false),
  ('transplant','Transplant Services','surgery','Transplant services',false),
  ('dialysis','Dialysis','dialysis','Dialysis (home or in-center)',false),
  ('medical_eye_care','Medical Eye Care','vision','Non-routine medical eye care (diagnose/treat eye disease)',false),
  ('covid_services','COVID-19 Tests & Therapeutics','preventive','COVID-19 testing and therapeutics',false)
) AS v(slug,name,category,descr,prev)
JOIN concepts c ON c.vocabulary_id='CANDID' AND c.concept_code=v.slug
ON CONFLICT (slug) DO NOTHING;

-- 2e. is_a relationships (concept_relationships; relationship_type='is_a').
INSERT INTO concept_relationships (concept_id_1, concept_id_2, relationship_type)
SELECT child.id, parent.id, 'is_a'
FROM (VALUES ('tubal_ligation','sterilization'),('vasectomy','sterilization'),
             ('non_preferred_specialty_rx','specialty_rx')) AS r(child_code,parent_code)
JOIN concepts child  ON child.vocabulary_id='CANDID'  AND child.concept_code=r.child_code
JOIN concepts parent ON parent.vocabulary_id='CANDID' AND parent.concept_code=r.parent_code
ON CONFLICT (concept_id_1, concept_id_2, relationship_type) DO NOTHING;

-- 2f. concept_indications — concept-level only (weight_loss_programs IS about weight loss).
--     Row-level indications (ED drugs→sexual_dysfunction, ortho→medically_necessary) live in
--     coverage_rules JSONB per row (Rule #9), not here.
INSERT INTO concept_indications (concept_id, indication_id)
SELECT c.id, 'weight_loss' FROM concepts c WHERE c.vocabulary_id='CANDID' AND c.concept_code='weight_loss_programs'
ON CONFLICT (concept_id, indication_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- PART 3 — Deterministic lossless transform of cold-start rows (§D)
-- ════════════════════════════════════════════════════════════════════════════

-- 3a. Recategorize-only slugs (keep slug; change category). No collision (no key change on slug).
UPDATE service_catalog SET category='dental', updated_at=now()
  WHERE slug IN ('childrens_dental','childrens_dental_checkup','adult_dental_care','dental_orthodontic');
UPDATE service_catalog SET category='vision', updated_at=now()
  WHERE slug IN ('childrens_eye_exam','childrens_glasses','routine_eye_care_adult','vision_hardware');
UPDATE service_catalog SET category='surgery', updated_at=now()
  WHERE slug IN ('bariatric_surgery','cosmetic_surgery');
UPDATE service_catalog SET category='therapy', updated_at=now()
  WHERE slug = 'weight_loss_programs';  -- + concept_indication weight_loss (2f)

-- 3b. Deprecate vision_exam (0 rows) → alias to routine_eye_care_adult (merge pattern).
UPDATE service_catalog
  SET merged_into_id = (SELECT id FROM service_catalog WHERE slug='routine_eye_care_adult'),
      merged_at = now(), deprecated_at = now(), updated_at = now()
  WHERE slug = 'vision_exam';

-- 3c. Rx role rename + place_of_service (retail vs 90-day mail). Repoint canonical rows' slug +
--     concept_id; old slug rows kept (deprecated 3e). place_of_service distinguishes retail/mail.
UPDATE canonical_plan_services cps SET service_slug='generic_rx', place_of_service='retail_pharmacy',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='generic_rx'), updated_at=now()
  WHERE service_slug='generic_rx_tier1';
UPDATE canonical_plan_services SET service_slug='generic_rx', place_of_service='home_delivery_pharmacy',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='generic_rx'), updated_at=now()
  WHERE service_slug='generic_rx_tier1_90day';
UPDATE canonical_plan_services SET service_slug='preferred_brand_rx', place_of_service='retail_pharmacy',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='preferred_brand_rx'), updated_at=now()
  WHERE service_slug='preferred_brand_rx_tier2';
UPDATE canonical_plan_services SET service_slug='preferred_brand_rx', place_of_service='home_delivery_pharmacy',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='preferred_brand_rx'), updated_at=now()
  WHERE service_slug='preferred_brand_rx_90day';
UPDATE canonical_plan_services SET service_slug='non_preferred_brand_rx', place_of_service='retail_pharmacy',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='non_preferred_brand_rx'), updated_at=now()
  WHERE service_slug='non_preferred_rx_tier3';
UPDATE canonical_plan_services SET service_slug='non_preferred_brand_rx', place_of_service='home_delivery_pharmacy',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='non_preferred_brand_rx'), updated_at=now()
  WHERE service_slug='non_preferred_rx_90day';
UPDATE canonical_plan_services SET service_slug='specialty_rx', place_of_service='retail_pharmacy',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='specialty_rx'), updated_at=now()
  WHERE service_slug='specialty_rx_tier4';
UPDATE canonical_plan_services SET service_slug='non_preferred_specialty_rx', place_of_service='retail_pharmacy',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='non_preferred_specialty_rx'), updated_at=now()
  WHERE service_slug='specialty_rx_tier5';  -- the tier4/5 collision fix (distinct slug)

-- 3d. Hospital/surgery: slug + place_of_service + component (facility vs professional distinguishes).
UPDATE canonical_plan_services SET service_slug='hospital_admission', place_of_service='inpatient_facility', component='facility',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='hospital_admission'), updated_at=now()
  WHERE service_slug='inpatient_facility';
UPDATE canonical_plan_services SET service_slug='hospital_admission', place_of_service='inpatient_facility', component='professional',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='hospital_admission'), updated_at=now()
  WHERE service_slug='inpatient_physician';
UPDATE canonical_plan_services SET service_slug='surgery', place_of_service='outpatient_facility', component='facility',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='surgery'), updated_at=now()
  WHERE service_slug='outpatient_surgery_facility';
UPDATE canonical_plan_services SET service_slug='surgery', place_of_service='outpatient_facility', component='professional',
  concept_id=(SELECT id FROM concepts WHERE vocabulary_id='CANDID' AND concept_code='surgery'), updated_at=now()
  WHERE service_slug='outpatient_surgery_physician';

-- 3e. Deprecate the old (now-orphaned) rx/hospital/surgery slug rows via the merge mechanism
--     (rows kept — billing_code_mappings.service_slug FK; alias to the new slug).
UPDATE service_catalog o SET
  merged_into_id = (SELECT n.id FROM service_catalog n WHERE n.slug = m.new_slug),
  merged_at = now(), deprecated_at = now(), updated_at = now()
FROM (VALUES
  ('generic_rx_tier1','generic_rx'),('generic_rx_tier1_90day','generic_rx'),
  ('preferred_brand_rx_tier2','preferred_brand_rx'),('preferred_brand_rx_90day','preferred_brand_rx'),
  ('non_preferred_rx_tier3','non_preferred_brand_rx'),('non_preferred_rx_90day','non_preferred_brand_rx'),
  ('specialty_rx_tier4','specialty_rx'),('specialty_rx_tier5','non_preferred_specialty_rx'),
  ('inpatient_facility','hospital_admission'),('inpatient_physician','hospital_admission'),
  ('outpatient_surgery_facility','surgery'),('outpatient_surgery_physician','surgery')
) AS m(old_slug,new_slug)
WHERE o.slug = m.old_slug;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (no users; correct-by-construction transform — rollback only if apply errors mid-way)
-- ════════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   -- reverse transform: repoint canonical rows back, un-deprecate old slugs, restore categories
--   UPDATE canonical_plan_services SET service_slug='generic_rx_tier1', place_of_service='any' WHERE service_slug='generic_rx' AND place_of_service='retail_pharmacy'; -- ...etc per 3c/3d
--   UPDATE service_catalog SET merged_into_id=NULL, merged_at=NULL, deprecated_at=NULL WHERE slug IN ('generic_rx_tier1',...);
--   UPDATE service_catalog SET category='preventive' WHERE slug IN ('childrens_dental_checkup',...); -- restore
--   DELETE FROM concept_indications WHERE indication_id IN ('weight_loss');
--   DELETE FROM concept_relationships WHERE relationship_type='is_a' AND concept_id_1 IN (SELECT id FROM concepts WHERE concept_code IN ('tubal_ligation','vasectomy','non_preferred_specialty_rx'));
--   DELETE FROM service_catalog WHERE slug IN ('generic_rx','preferred_brand_rx',...);  -- new slugs
--   DELETE FROM concepts WHERE vocabulary_id='CANDID' AND concept_code IN ('generic_rx',...);
--   DELETE FROM service_categories WHERE id IN ('dental','vision','surgery','hospitalization','dialysis','family_planning');
--   DELETE FROM service_indications WHERE id IN ('sexual_dysfunction','medically_necessary','weight_loss');
--   -- re-apply mig 129's apply_promotion_event (8-param) + ALTER canonical_promotion_events DROP COLUMN place_of_service, component;
-- COMMIT;
