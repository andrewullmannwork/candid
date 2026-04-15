-- Migration 032: Merge bariatric_obesity_surgery → bariatric_surgery
--
-- Haiku auto-created bariatric_obesity_surgery when bariatric_surgery wasn't
-- in STANDARD_SLUGS. The canonical slug is bariatric_surgery (migration 010).
-- Merge all references and soft-delete the duplicate.

DO $$
DECLARE
  _old_id UUID;
  _new_id UUID;
BEGIN
  SELECT id INTO _old_id FROM service_catalog WHERE slug = 'bariatric_obesity_surgery';
  SELECT id INTO _new_id FROM service_catalog WHERE slug = 'bariatric_surgery';

  -- Skip if the duplicate doesn't exist
  IF _old_id IS NULL THEN
    RAISE NOTICE 'bariatric_obesity_surgery not found — nothing to merge';
    RETURN;
  END IF;

  IF _new_id IS NULL THEN
    RAISE NOTICE 'bariatric_surgery not found — renaming instead';
    UPDATE service_catalog SET slug = 'bariatric_surgery' WHERE id = _old_id;
    RETURN;
  END IF;

  -- Update plan_covered_services references
  UPDATE plan_covered_services SET service_id = _new_id
  WHERE service_id = _old_id
    AND NOT EXISTS (
      SELECT 1 FROM plan_covered_services pcs2
      WHERE pcs2.plan_id = plan_covered_services.plan_id
        AND pcs2.service_id = _new_id
        AND pcs2.place_of_service = plan_covered_services.place_of_service
    );
  -- Delete remaining duplicates that couldn't be updated due to uniqueness
  DELETE FROM plan_covered_services WHERE service_id = _old_id;

  -- Update canonical_plan_services references
  UPDATE canonical_plan_services SET service_slug = 'bariatric_surgery'
  WHERE service_slug = 'bariatric_obesity_surgery'
    AND NOT EXISTS (
      SELECT 1 FROM canonical_plan_services cps2
      WHERE cps2.canonical_plan_id = canonical_plan_services.canonical_plan_id
        AND cps2.service_slug = 'bariatric_surgery'
        AND cps2.place_of_service = canonical_plan_services.place_of_service
    );
  DELETE FROM canonical_plan_services WHERE service_slug = 'bariatric_obesity_surgery';

  -- Update claim_line_items references
  UPDATE claim_line_items SET service_slug = 'bariatric_surgery'
  WHERE service_slug = 'bariatric_obesity_surgery';

  -- Soft-delete the duplicate
  UPDATE service_catalog SET merged_into_id = _new_id, merged_at = NOW() WHERE id = _old_id;

  RAISE NOTICE 'Merged bariatric_obesity_surgery → bariatric_surgery';
END $$;
