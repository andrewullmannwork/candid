-- Migration 064: canonical_plan_services field_provenance atomic merge
--
-- Bundle PR #1 / Session 55 — closes audit item #13 (concurrent write race +
-- citation diversity loss on canonical_plan_services UPSERT).
--
-- PROBLEM
-- The current UPSERT in src/lib/plan/process-plan.ts on canonical_plan_services
-- overwrites field_provenance JSONB top-level keys on conflict. Concurrent writers
-- from different users uploading the same plan lose cross-field citation diversity:
-- USER A writes provenance for {deductible_individual, copay}; USER B then writes
-- provenance for {oop_max_individual, copay} → USER A's deductible_individual key
-- is silently dropped.
--
-- The Supabase JS client cannot wrap SELECT-merge-UPSERT in a single Postgres
-- transaction (each call is an independent HTTP request to PostgREST landing on a
-- different pgbouncer connection). Pattern 2's spec for an advisory lock per
-- user_id is unimplementable from the client side.
--
-- FIX
-- This PL/pgSQL function performs the SELECT → shallow JSONB merge → UPSERT
-- atomically inside a single transaction, holding pg_advisory_xact_lock keyed on
-- canonical_plan_id (auto-released at commit). Different canonical_plan_id values
-- run in parallel; same canonical_plan_id serializes.
--
-- SCOPE
-- - Only field_provenance gets merge treatment (existing JSONB || new JSONB).
-- - Other columns (copay, coinsurance, is_covered, etc.) keep last-writer-wins
--   semantics — matching the prior UPSERT behavior for these fields.
-- - Within-field citation diversity (sources array per field) DEFERRED to Phase 4
--   Subplan; this migration only preserves cross-field diversity.

CREATE OR REPLACE FUNCTION upsert_canonical_services_with_merge(
  p_canonical_plan_id uuid,
  p_inserts jsonb  -- array of row objects matching canonical_plan_services columns
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock_key bigint;
  v_row jsonb;
  v_service_slug text;
  v_existing_provenance jsonb;
  v_new_provenance jsonb;
  v_merged_provenance jsonb;
BEGIN
  -- Acquire txn-scoped advisory lock keyed on canonical_plan_id.
  -- hashtextextended returns int8 (bigint) for use with pg_advisory_xact_lock(bigint).
  -- Auto-released on transaction commit/rollback.
  v_lock_key := hashtextextended('canonical_plan:' || p_canonical_plan_id::text, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Iterate over each row in the batch
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_inserts)
  LOOP
    v_service_slug := v_row->>'service_slug';
    v_new_provenance := COALESCE(v_row->'field_provenance', '{}'::jsonb);

    -- Look up existing field_provenance under the lock
    SELECT field_provenance INTO v_existing_provenance
    FROM canonical_plan_services
    WHERE canonical_plan_id = p_canonical_plan_id
      AND service_slug = v_service_slug;

    -- Shallow merge: existing || new. New wins for shared top-level keys; existing-only
    -- keys preserved. Each Pattern P-8 field's provenance is a flat object directly
    -- under the field name, so shallow merge at top level is the correct semantic.
    v_merged_provenance := COALESCE(v_existing_provenance, '{}'::jsonb) || v_new_provenance;

    INSERT INTO canonical_plan_services (
      canonical_plan_id,
      concept_id,
      service_slug,
      copay,
      coinsurance,
      is_covered,
      requires_prior_auth,
      requires_referral,
      deductible_applies,
      annual_limit,
      visit_limit,
      coverage_rules,
      confidence,
      source,
      field_provenance
    )
    VALUES (
      p_canonical_plan_id,
      NULLIF(v_row->>'concept_id', '')::uuid,
      v_service_slug,
      (v_row->>'copay')::numeric,
      (v_row->>'coinsurance')::numeric,
      COALESCE((v_row->>'is_covered')::boolean, true),
      COALESCE((v_row->>'requires_prior_auth')::boolean, false),
      COALESCE((v_row->>'requires_referral')::boolean, false),
      COALESCE((v_row->>'deductible_applies')::boolean, true),
      (v_row->>'annual_limit')::numeric,
      (v_row->>'visit_limit')::int,
      COALESCE(v_row->'coverage_rules', '{}'::jsonb),
      (v_row->>'confidence')::numeric,
      v_row->>'source',
      v_merged_provenance
    )
    ON CONFLICT (canonical_plan_id, service_slug) DO UPDATE SET
      concept_id = EXCLUDED.concept_id,
      copay = EXCLUDED.copay,
      coinsurance = EXCLUDED.coinsurance,
      is_covered = EXCLUDED.is_covered,
      requires_prior_auth = EXCLUDED.requires_prior_auth,
      requires_referral = EXCLUDED.requires_referral,
      deductible_applies = EXCLUDED.deductible_applies,
      annual_limit = EXCLUDED.annual_limit,
      visit_limit = EXCLUDED.visit_limit,
      coverage_rules = EXCLUDED.coverage_rules,
      confidence = EXCLUDED.confidence,
      source = EXCLUDED.source,
      field_provenance = EXCLUDED.field_provenance;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION upsert_canonical_services_with_merge IS
  'Atomic upsert with field_provenance shallow-merge per Pattern P-8 + Bundle PR #1 (Session 55, audit item #13). Holds pg_advisory_xact_lock per canonical_plan_id to serialize concurrent writers and preserve cross-field citation diversity. Within-field citation diversity (sources array per field) deferred to Phase 4 Subplan.';

GRANT EXECUTE ON FUNCTION upsert_canonical_services_with_merge(uuid, jsonb) TO authenticated, service_role;
