-- S74.6 D4 §D.3 — Extend apply_corrector_upsert to accept + persist haiku_score
-- on SourceEntry JSONB, and admit the new CorroboratorSource types introduced
-- in S87 (bill_observed_description_match, bill_observed_description_match_candidate,
-- admin_seed, dispute_won_recoding).
--
-- WHY THIS IS NEEDED
-- ------------------
-- S87 added 4 new source types to the TypeScript SourceEntry interface but the
-- DB-side RPC still rejected anything outside ('user_correction', 'bill_observed').
-- S88 §D.1 + §D.2 + §E.1 all need to write through this RPC; otherwise the
-- flywheel doesn't accumulate Haiku votes (S87 close called this out as the
-- biggest deferred item — vote-writing).
--
-- haiku_score persistence: SourceEntry interface already declares haiku_score
-- optional; the RPC just needs to thread the new parameter into the JSONB entry.
-- Downstream admin disambiguation UI (Phase 2 A1) consumes the score for
-- "why did Haiku pick this slug?" telemetry display.
--
-- SOURCE PRIORITY UPGRADE
-- -----------------------
-- Current rule: existing 'user_correction' cannot be overwritten by 'bill_observed'.
-- Generalized: existing 'user_correction' cannot be overwritten by ANY non-correction
-- source. Explicit user vote sticks across all passive ingestion paths.
--
-- BACKWARD COMPATIBILITY
-- ----------------------
-- Old callers (recordParserObservation, recordUserCorrection) don't pass haiku_score
-- → defaults to NULL → SourceEntry JSONB omits the field → no behavioral change
-- for the back-compat path.

-- Drop the old signature first (adding a parameter changes the signature; CREATE
-- OR REPLACE can't alter signatures, only bodies). Standard candid migration
-- pattern (see mig 091 promote_with_slug rebuild).
DROP FUNCTION IF EXISTS apply_corrector_upsert(UUID, TEXT, TEXT, TEXT, TEXT, UUID, INT);

CREATE OR REPLACE FUNCTION apply_corrector_upsert(
  p_identity_id      UUID,
  p_user_id_hash     TEXT,
  p_proposed_slug    TEXT,            -- NULL for non-voting sources (bill_observed, bill_observed_description_match_candidate)
  p_source           TEXT,            -- per CorroboratorSource enum (TypeScript-side)
  p_raw_description  TEXT,
  p_claim_line_item_id UUID DEFAULT NULL,
  p_max_sources      INT DEFAULT 5,
  p_haiku_score      FLOAT DEFAULT NULL  -- S74.6 D4 §D.3 — Haiku similarity 0..1 for description-match sources
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock_key          BIGINT;
  v_identity          billing_code_identity%ROWTYPE;
  v_existing_entry    JSONB;
  v_existing_source   TEXT;
  v_new_entry         JSONB;
  v_filtered_sources  JSONB;
  v_merged_sources    JSONB;
  v_new_count         INT;
  v_is_new_contributor BOOLEAN;
  v_examples          TEXT[];
  v_now               TIMESTAMPTZ := now();
BEGIN
  -- S74.6 D4 §D.3: admit the 6 source types defined in the TypeScript
  -- CorroboratorSource union. Any addition there MUST also be added here.
  IF p_source NOT IN (
    'user_correction',
    'bill_observed',
    'bill_observed_description_match',
    'bill_observed_description_match_candidate',
    'admin_seed',
    'dispute_won_recoding'
  ) THEN
    RAISE EXCEPTION 'apply_corrector_upsert: invalid p_source %; must match CorroboratorSource enum', p_source;
  END IF;

  SELECT * INTO v_identity FROM billing_code_identity WHERE id = p_identity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_corrector_upsert: billing_code_identity row % not found', p_identity_id;
  END IF;

  -- Composite-key lock matches apply_mapping_promotion so a concurrent
  -- promotion + corrector-upsert serialize cleanly.
  v_lock_key := hashtextextended(
    'mapping_promotion:' || v_identity.billing_code || ':' || v_identity.billing_code_type || ':' || v_identity.description_signature,
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Re-read under lock.
  SELECT * INTO v_identity FROM billing_code_identity WHERE id = p_identity_id;

  -- Locate any existing entry for this user
  SELECT s INTO v_existing_entry
  FROM jsonb_array_elements(COALESCE(v_identity.corroborator_sources, '[]'::jsonb)) AS s
  WHERE s->>'user_id_hash' = p_user_id_hash
  LIMIT 1;

  v_existing_source := COALESCE(v_existing_entry->>'source', NULL);
  v_is_new_contributor := v_existing_entry IS NULL;

  -- S74.6 D4 §D.3 generalized source-priority: existing 'user_correction' entries
  -- cannot be overwritten by ANY non-user-correction source. Explicit user vote
  -- sticks across all passive ingestion paths (bill_observed, description_match,
  -- description_match_candidate, admin_seed, dispute_won_recoding).
  IF v_existing_source = 'user_correction' AND p_source != 'user_correction' THEN
    -- No change to sources; just touch last_corroborated_at
    UPDATE billing_code_identity
    SET last_corroborated_at = v_now,
        updated_at = v_now
    WHERE id = p_identity_id;

    RETURN jsonb_build_object(
      'is_new_contributor', false,
      'distinct_user_count', v_identity.distinct_user_count,
      'service_slug', v_identity.service_slug,
      'promotion_state', v_identity.promotion_state,
      'skipped_reason', 'existing_user_correction_takes_precedence'
    );
  END IF;

  -- Build new entry. haiku_score included only when non-null to keep the
  -- JSONB shape minimal for sources that don't carry it.
  v_new_entry := jsonb_build_object(
    'user_id_hash', p_user_id_hash,
    'proposed_slug', p_proposed_slug,
    'source', p_source,
    'raw_description', p_raw_description,
    'claim_line_item_id', p_claim_line_item_id,
    'recorded_at', v_now
  );
  IF p_haiku_score IS NOT NULL THEN
    v_new_entry := v_new_entry || jsonb_build_object('haiku_score', p_haiku_score);
  END IF;

  -- Drop existing entry for this user (if any), then append the new one
  v_filtered_sources := (
    SELECT COALESCE(jsonb_agg(s), '[]'::jsonb)
    FROM jsonb_array_elements(COALESCE(v_identity.corroborator_sources, '[]'::jsonb)) AS s
    WHERE s->>'user_id_hash' != p_user_id_hash
  );
  v_merged_sources := v_filtered_sources || jsonb_build_array(v_new_entry);

  -- Bound top-K (most recent kept). Keep all user_correction entries first
  -- (votes matter), then trim to p_max_sources.
  v_merged_sources := (
    SELECT COALESCE(jsonb_agg(s ORDER BY
      CASE WHEN s->>'source' = 'user_correction' THEN 0 ELSE 1 END,
      (s->>'recorded_at')::timestamptz DESC
    ), '[]'::jsonb)
    FROM (
      SELECT s FROM jsonb_array_elements(v_merged_sources) AS s
      ORDER BY
        CASE WHEN s->>'source' = 'user_correction' THEN 0 ELSE 1 END,
        (s->>'recorded_at')::timestamptz DESC
      LIMIT p_max_sources
    ) AS t(s)
  );

  -- Recompute distinct_user_count from merged sources
  v_new_count := (
    SELECT COUNT(DISTINCT s->>'user_id_hash')::INT
    FROM jsonb_array_elements(v_merged_sources) AS s
  );

  -- description_examples top-5 (dedup, prepend new)
  v_examples := COALESCE(v_identity.description_examples, ARRAY[]::TEXT[]);
  IF p_raw_description IS NOT NULL AND NOT (p_raw_description = ANY(v_examples)) THEN
    v_examples := (ARRAY[p_raw_description] || v_examples)[1:5];
  END IF;

  UPDATE billing_code_identity
  SET corroborator_sources = v_merged_sources,
      description_examples = v_examples,
      distinct_user_count  = v_new_count,
      last_corroborated_at = v_now,
      updated_at           = v_now
  WHERE id = p_identity_id;

  RETURN jsonb_build_object(
    'is_new_contributor', v_is_new_contributor,
    'distinct_user_count', v_new_count,
    'service_slug', v_identity.service_slug,
    'promotion_state', v_identity.promotion_state
  );
END;
$$;

COMMENT ON FUNCTION apply_corrector_upsert(UUID, TEXT, TEXT, TEXT, TEXT, UUID, INT, FLOAT) IS
  'S74.5 §3.5 + S74.6 D4 §D.3 — advisory-locked atomic corrector upsert on billing_code_identity.corroborator_sources. Source whitelist matches TypeScript CorroboratorSource enum (user_correction, bill_observed, bill_observed_description_match, bill_observed_description_match_candidate, admin_seed, dispute_won_recoding). Source-priority: existing user_correction entries are NOT overwritten by any non-user-correction source. haiku_score is persisted on SourceEntry JSONB when non-null (used by D4 description-match sources). distinct_user_count is recomputed from merged sources as COUNT(DISTINCT user_id_hash) over the ACTIVE bounded array (top-K = p_max_sources, default 5). service_slug is NEVER touched by this RPC — only apply_mapping_promotion (or promote_with_slug) writes it at promotion time.';

GRANT EXECUTE ON FUNCTION apply_corrector_upsert(UUID, TEXT, TEXT, TEXT, TEXT, UUID, INT, FLOAT) TO service_role;
