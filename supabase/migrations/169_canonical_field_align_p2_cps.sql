-- Migration 169: Canonical Field-Name Alignment — Phase 2 (canonical_plan_services)
-- F.0 per plans/canonical_field_alignment.md §9 + §4 Phase 2 (S208, 2026-06-22). ADDITIVE + REVERSIBLE.
--
-- WHY
--   Phase 1 (mig 165) ADDed the aligned columns (in_copay / in_coinsurance / in_deductible_applies /
--   covered / prior_auth_required) + provenance twins + a ONE-DIRECTIONAL dual-write mirror
--   (legacy -> aligned; legacy authoritative). Phase 2 makes the ALIGNED names authoritative so
--   per-service corroboration reads the 48,552-row cold-start canonical under ONE name end-to-end:
--     candidate 'in_copay' (Part 1) -> user provenance 'in_copay' -> canonical read 'in_copay' ->
--     evaluate_pattern1_corroboration (dynamic p_field_name) -> apply_promotion_event writes in_copay -> column.
--
-- WHAT (Phase 2 of 5; canonical_plan_services ONLY — canonical_plans is Phase 5)
--   1. apply_promotion_event: flip the PER-SERVICE arm (the ELSE branch) from legacy to aligned column
--      names in BOTH the INSERT VALUES and the ON CONFLICT DO UPDATE SET
--      (copay->in_copay, coinsurance->in_coinsurance, deductible_applies->in_deductible_applies,
--      is_covered->covered, requires_prior_auth->prior_auth_required). annual_limit already aligned.
--      field_provenance is keyed by p_field_name DYNAMICALLY — callers now pass 'in_copay' etc. (Part 1)
--      so provenance lands under aligned keys with NO body change. The plan-identity arm (canonical_plans)
--      is UNCHANGED (Phase 5). Signature UNCHANGED -> CREATE OR REPLACE (no DROP).
--   2. align_mirror_cps_row(): REPLACE the one-directional (legacy->aligned) mirror with a SYMMETRIC /
--      idempotent one that keeps the legacy+aligned twins equal regardless of which side a writer set,
--      with ALIGNED precedence.
--        INSERT: aligned provided -> mirror to legacy; else mirror from legacy.
--        UPDATE: propagate whichever side CHANGED (IS DISTINCT FROM OLD); aligned precedence on a tie.
--        Provenance: bidirectional twin (aligned precedence).
--      Robust to: (a) writers still on legacy names (canonical-match before this PR; the cold-start importer
--      wire-plan-catalog-to-canonical.ts; admin/reset scripts), (b) future writers from other lanes,
--      (c) migration-vs-code deploy ordering. A one-directional SWAP would CLOBBER any legacy-only INSERT
--      (aligned NULL -> legacy := NULL). See plans/canonical_field_alignment.md §9 (the reviewed defect).
--   3. DROP DEFAULT on the 3 aligned booleans (covered / in_deductible_applies / prior_auth_required) so a
--      NULL aligned column reliably signals "this writer did not set the aligned side" (the INSERT symmetric
--      rule needs that signal). Legacy keeps its DEFAULTs (true/true/false), which flow to aligned via the
--      trigger. Metadata-only; existing 48,552 rows keep their backfilled values.
--
-- FIRE-ORDER (unchanged): trigger canonical_plan_services_align_dualwrite ('align' < 'confidence') still
--   fires BEFORE canonical_plan_services_confidence_recompute (mig 056); each twin carries identical
--   confidence so MIN(non-'_' keys) is unchanged (Phase-1 parity gate already proved this with the twins).
--
-- DEPLOY ORDER: apply this migration (Studio) BEFORE the Phase-2 code promotes. The symmetric trigger
--   covers the window — the flipped function writes aligned (mirrored to legacy); any writer still on
--   legacy is mirrored to aligned. (A code-first order would let the OLD Phase-1 mirror clobber the
--   function's aligned writes, hence mig-first.)
--
-- ROLLBACK (reversible — legacy columns + keys still populated, aligned mirrored, both equal):
--   Re-apply mig 165's align_mirror_cps_row() (one-directional legacy->aligned) + mig 157's
--   apply_promotion_event (legacy per-service arm) + re-add the 3 aligned boolean DEFAULTs:
--     ALTER TABLE canonical_plan_services
--       ALTER COLUMN in_deductible_applies SET DEFAULT true,
--       ALTER COLUMN covered               SET DEFAULT true,
--       ALTER COLUMN prior_auth_required   SET DEFAULT false;
--   No data loss (pre-Phase-2 legacy authoritative; both sides equal at all times).

BEGIN;

-- ── 1. Drop aligned-boolean DEFAULTs (NULL aligned => "writer didn't set aligned"; legacy keeps DEFAULTs) ──
ALTER TABLE canonical_plan_services
  ALTER COLUMN in_deductible_applies DROP DEFAULT,
  ALTER COLUMN covered               DROP DEFAULT,
  ALTER COLUMN prior_auth_required   DROP DEFAULT;

-- ── 2. Symmetric / idempotent dual-write mirror (aligned precedence; robust to writer + deploy order) ──
CREATE OR REPLACE FUNCTION align_mirror_cps_row()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- aligned-provided wins (mirror to legacy); else mirror from legacy
    IF NEW.in_copay              IS NOT NULL THEN NEW.copay               := NEW.in_copay;              ELSE NEW.in_copay              := NEW.copay;               END IF;
    IF NEW.in_coinsurance        IS NOT NULL THEN NEW.coinsurance         := NEW.in_coinsurance;        ELSE NEW.in_coinsurance        := NEW.coinsurance;         END IF;
    IF NEW.in_deductible_applies IS NOT NULL THEN NEW.deductible_applies  := NEW.in_deductible_applies; ELSE NEW.in_deductible_applies := NEW.deductible_applies;  END IF;
    IF NEW.covered               IS NOT NULL THEN NEW.is_covered          := NEW.covered;               ELSE NEW.covered               := NEW.is_covered;          END IF;
    IF NEW.prior_auth_required   IS NOT NULL THEN NEW.requires_prior_auth := NEW.prior_auth_required;   ELSE NEW.prior_auth_required   := NEW.requires_prior_auth; END IF;
  ELSE  -- UPDATE: propagate whichever side changed (aligned precedence on a tie)
    IF    NEW.in_copay IS DISTINCT FROM OLD.in_copay THEN NEW.copay := NEW.in_copay;
    ELSIF NEW.copay    IS DISTINCT FROM OLD.copay    THEN NEW.in_copay := NEW.copay; END IF;
    IF    NEW.in_coinsurance IS DISTINCT FROM OLD.in_coinsurance THEN NEW.coinsurance := NEW.in_coinsurance;
    ELSIF NEW.coinsurance    IS DISTINCT FROM OLD.coinsurance    THEN NEW.in_coinsurance := NEW.coinsurance; END IF;
    IF    NEW.in_deductible_applies IS DISTINCT FROM OLD.in_deductible_applies THEN NEW.deductible_applies := NEW.in_deductible_applies;
    ELSIF NEW.deductible_applies    IS DISTINCT FROM OLD.deductible_applies    THEN NEW.in_deductible_applies := NEW.deductible_applies; END IF;
    IF    NEW.covered    IS DISTINCT FROM OLD.covered    THEN NEW.is_covered := NEW.covered;
    ELSIF NEW.is_covered IS DISTINCT FROM OLD.is_covered THEN NEW.covered := NEW.is_covered; END IF;
    IF    NEW.prior_auth_required   IS DISTINCT FROM OLD.prior_auth_required   THEN NEW.requires_prior_auth := NEW.prior_auth_required;
    ELSIF NEW.requires_prior_auth   IS DISTINCT FROM OLD.requires_prior_auth   THEN NEW.prior_auth_required := NEW.requires_prior_auth; END IF;
  END IF;

  -- provenance: keep each legacy/aligned IN-NETWORK key pair twinned, ALIGNED precedence.
  -- out_* keys already match the convention -> untouched. Legacy keys PRESERVED (dual-key through Phase 3).
  IF NEW.field_provenance IS NOT NULL AND NEW.field_provenance <> '{}'::jsonb THEN
    IF    NEW.field_provenance ? 'in_copay'              THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('copay',               NEW.field_provenance->'in_copay');
    ELSIF NEW.field_provenance ? 'copay'                 THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_copay',              NEW.field_provenance->'copay'); END IF;
    IF    NEW.field_provenance ? 'in_coinsurance'        THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('coinsurance',         NEW.field_provenance->'in_coinsurance');
    ELSIF NEW.field_provenance ? 'coinsurance'           THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_coinsurance',        NEW.field_provenance->'coinsurance'); END IF;
    IF    NEW.field_provenance ? 'in_deductible_applies' THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('deductible_applies',  NEW.field_provenance->'in_deductible_applies');
    ELSIF NEW.field_provenance ? 'deductible_applies'    THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_deductible_applies', NEW.field_provenance->'deductible_applies'); END IF;
    IF    NEW.field_provenance ? 'covered'               THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('is_covered',          NEW.field_provenance->'covered');
    ELSIF NEW.field_provenance ? 'is_covered'            THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('covered',               NEW.field_provenance->'is_covered'); END IF;
    IF    NEW.field_provenance ? 'prior_auth_required'   THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('requires_prior_auth', NEW.field_provenance->'prior_auth_required');
    ELSIF NEW.field_provenance ? 'requires_prior_auth'   THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('prior_auth_required',  NEW.field_provenance->'requires_prior_auth'); END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger body unchanged (BEFORE INSERT OR UPDATE; name preserves the 'align' < 'confidence' fire-order).
-- DROP + CREATE (version-safe; matches mig 165/166). NOT "CREATE OR REPLACE TRIGGER" — that is PG14+ only
-- and would abort the whole transaction on an older Postgres. The existing trigger (mig 165) already calls
-- align_mirror_cps_row(); the CREATE OR REPLACE FUNCTION above swapped its body to the symmetric version —
-- re-creating the trigger just keeps the migration self-contained.
DROP TRIGGER IF EXISTS canonical_plan_services_align_dualwrite ON canonical_plan_services;
CREATE TRIGGER canonical_plan_services_align_dualwrite
  BEFORE INSERT OR UPDATE ON canonical_plan_services
  FOR EACH ROW
  EXECUTE FUNCTION align_mirror_cps_row();

-- ── 3. apply_promotion_event — PER-SERVICE arm flipped to aligned names (reproduced from mig 157; ──
--       ONLY the canonical_plan_services INSERT + ON CONFLICT UPDATE column names/CASE conditions change) ──
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
  v_pos TEXT := COALESCE(p_place_of_service, 'any');
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

  -- Advisory lock — delimited + pos/component (4-col cell).
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
    FOR UPDATE;  -- 4-col target; may not exist yet (first promotion -> INSERT below)
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
    -- UNCHANGED (plan-identity typed-col sync; canonical_plans is F.0 Phase 5).
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
    -- F.0 Phase 2 (mig 169): per-service typed columns now ALIGNED names (in_copay/in_coinsurance/
    -- in_deductible_applies/covered/prior_auth_required); annual_limit already aligned. field_provenance
    -- keyed by p_field_name dynamically (callers pass 'in_copay' etc.). The symmetric trigger mirrors the
    -- aligned writes back to the legacy columns/keys through the Phase-3 deprecation window.
    INSERT INTO canonical_plan_services (
      canonical_plan_id, service_slug, place_of_service, component,
      confidence, source, field_provenance, in_copay, in_coinsurance, in_deductible_applies, covered, prior_auth_required, annual_limit)
    VALUES (
      p_canonical_plan_id, p_service_slug, v_pos, v_component,
      0.9, CASE WHEN v_event_type='admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      jsonb_build_object(p_field_name, v_new_field_entry),
      CASE WHEN p_field_name='in_copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE NULL END,
      CASE WHEN p_field_name='in_coinsurance' AND jsonb_typeof(p_corroborated_value)='number'
        THEN LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC, CASE WHEN ((p_corroborated_value)::TEXT::NUMERIC)>1 THEN ((p_corroborated_value)::TEXT::NUMERIC)/100 ELSE (p_corroborated_value)::TEXT::NUMERIC END)) ELSE NULL END,
      CASE WHEN p_field_name='in_deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='covered' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='prior_auth_required' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE NULL END,
      CASE WHEN p_field_name='annual_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE NULL END)
    ON CONFLICT (canonical_plan_id, service_slug, place_of_service, component) DO UPDATE SET
      field_provenance = jsonb_set(COALESCE(canonical_plan_services.field_provenance, '{}'::jsonb), ARRAY[p_field_name], v_new_field_entry, true),
      confidence = GREATEST(canonical_plan_services.confidence, 0.9),
      source = CASE WHEN v_event_type='admin_override' THEN 'admin_attested' ELSE 'multi_source_corroboration' END,
      in_copay = CASE WHEN p_field_name='in_copay' AND jsonb_typeof(p_corroborated_value)='number' THEN (p_corroborated_value)::TEXT::NUMERIC ELSE canonical_plan_services.in_copay END,
      in_coinsurance = CASE WHEN p_field_name='in_coinsurance' AND jsonb_typeof(p_corroborated_value)='number'
        THEN LEAST(1.0::NUMERIC, GREATEST(0.0::NUMERIC, CASE WHEN ((p_corroborated_value)::TEXT::NUMERIC)>1 THEN ((p_corroborated_value)::TEXT::NUMERIC)/100 ELSE (p_corroborated_value)::TEXT::NUMERIC END)) ELSE canonical_plan_services.in_coinsurance END,
      in_deductible_applies = CASE WHEN p_field_name='in_deductible_applies' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.in_deductible_applies END,
      covered = CASE WHEN p_field_name='covered' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.covered END,
      prior_auth_required = CASE WHEN p_field_name='prior_auth_required' AND jsonb_typeof(p_corroborated_value)='boolean' THEN (p_corroborated_value)::TEXT::BOOLEAN ELSE canonical_plan_services.prior_auth_required END,
      annual_limit = CASE WHEN p_field_name='annual_limit' AND jsonb_typeof(p_corroborated_value)='number' THEN ((p_corroborated_value)::TEXT::NUMERIC)::INTEGER ELSE canonical_plan_services.annual_limit END,
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
  'F.0 Phase 2 (mig 169): canonical promotion writer, cell-aware (4-col). Per-service arm writes the ALIGNED '
  'columns (in_copay/in_coinsurance/in_deductible_applies/covered/prior_auth_required + annual_limit) keyed by '
  'p_field_name; the symmetric align_mirror_cps_row trigger mirrors them to the legacy columns/keys through the '
  'Phase-3 window. Plan-identity (canonical_plans) arm UNCHANGED (F.0 Phase 5). Reproduced verbatim from '
  'mig 157 (S167 mig 148 + annual_limit) — ONLY the per-service column names + CASE conditions changed.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only; Supabase Studio can falsely report success on a partial run — run these after apply):
--   1) aligned boolean DEFAULTs dropped (expect NULL for all 3):
-- SELECT column_name, column_default FROM information_schema.columns
--   WHERE table_name='canonical_plan_services' AND column_name IN ('covered','in_deductible_applies','prior_auth_required');
--   2) trigger present + fires before confidence recompute (expect align_dualwrite listed before confidence_recompute):
-- SELECT tgname FROM pg_trigger WHERE tgrelid='canonical_plan_services'::regclass AND NOT tgisinternal ORDER BY tgname;
--   3) per-service arm flipped (expect t):
-- SELECT pg_get_functiondef('apply_promotion_event(uuid,text,text,jsonb,jsonb,text,uuid,text,text,text)'::regprocedure)
--          LIKE '%in_copay = CASE WHEN p_field_name=''in_copay''%' AS per_service_flipped;
-- ─────────────────────────────────────────────────────────────────────────────────────────────
