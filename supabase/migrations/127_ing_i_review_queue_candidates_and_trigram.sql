-- =============================================================================
-- MIGRATION 127 — Ing-I: candidate-slug suggestions + MERGE alias mechanism
--                 on /admin/review-queue (Pattern 1 #1 vocabulary fragmentation
--                 defense)
-- =============================================================================
--
-- Per `plans/pre_launch_backend_hardening.md` §5 Ing-I + `Candid_Backend_Opus.md`
-- §Ingestion §4 item I: when an admin reviews a pending row in
-- `service_catalog_admin_review_queue`, today they must mentally browse 68+
-- existing canonical slugs to judge whether the proposed slug is a duplicate
-- (REJECT-as-duplicate) or genuinely novel (PROMOTE-as-new). The admin
-- throughput drops + vocabulary fragmentation accumulates when the same
-- concept gets promoted twice under different slugs (`physical_therapy` vs
-- `pt_rehab`), splitting canonical_plan_services rows across siblings.
--
-- This mig adds:
--   1. Cached candidate suggestions per pending row (JSONB top-K w/ scores)
--   2. trigram (pg_trgm) GIN indexes on service_catalog.slug + name + description
--      for the Pass 1 cheap-similarity resolver
--   3. RPC `find_service_catalog_candidates()` for Pass 1 trigram resolver
--   4. RPC `merge_proposed_slug_into_canonical()` for atomic MERGE flow
--      (per Ship Gate G7 concurrency review: single-round-trip + advisory lock
--      avoids the race condition between INSERT alias row + UPDATE queue row)
--   5. Extend service_catalog_admin_review_queue.status enum to include 'merged'
--   6. Extend parse_cost_events.parser_kind enum to include 'admin_candidate_match'
--      so Pass 2 Haiku description-match calls write to the unified Cost-F
--      ledger (S129 Cost-F architecture compliance)
--   7. Seed `candidate_suggestions_config` flag (mirrors mig 075 INSERT shape
--      per feedback_candid_feature_flag_schema) for tunable resolver thresholds
--      WITHOUT code deploy
--
-- SCOPE EXCLUSIONS (deferred to Phase 2+ with concrete triggers):
--   - concept_admin_review_queue candidate suggestions + MERGE: concept-side
--     alias mechanism differs (no canonical_for_concept flag on concepts table);
--     Phase 2+ block adds its own mig
--   - Side-by-side cost-sharing diff in candidate panel: cosmetic enhancement;
--     trigger = first MERGE retrospective flagging "needed more info"
--   - Auto-merge on score ≥ 0.9 + bulk-approval queue: trigger = MERGE volume
--     > 10/week sustained for 4 weeks post-launch
--
-- BACKOUT:
--   ALTER TABLE service_catalog_admin_review_queue DROP COLUMN candidate_suggestions, DROP COLUMN candidate_suggestions_computed_at;
--   ALTER TABLE service_catalog_admin_review_queue DROP CONSTRAINT service_catalog_admin_review_queue_status_check;
--   ALTER TABLE service_catalog_admin_review_queue ADD CONSTRAINT service_catalog_admin_review_queue_status_check CHECK (status IN ('pending', 'promoted', 'rejected'));
--   DROP INDEX IF EXISTS idx_service_catalog_slug_trgm;
--   DROP INDEX IF EXISTS idx_service_catalog_name_trgm;
--   DROP INDEX IF EXISTS idx_service_catalog_description_trgm;
--   DROP FUNCTION IF EXISTS find_service_catalog_candidates;
--   DROP FUNCTION IF EXISTS merge_proposed_slug_into_canonical;
--   ALTER TABLE parse_cost_events DROP CONSTRAINT parse_cost_events_parser_kind_check;
--   ALTER TABLE parse_cost_events ADD CONSTRAINT parse_cost_events_parser_kind_check CHECK (parser_kind IN ('sbc_base', 'eoc_base', 'plan_doc_base', 'reparse_field', 'reparse_field_batch', 'card_scan', 'bill_parse', 'eob_parse'));
--   DELETE FROM feature_flag_rules WHERE flag_key = 'candidate_suggestions_config';
-- =============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1 — service_catalog_admin_review_queue columns + status enum
-- ============================================================================

ALTER TABLE service_catalog_admin_review_queue
  ADD COLUMN IF NOT EXISTS candidate_suggestions JSONB NULL,
  ADD COLUMN IF NOT EXISTS candidate_suggestions_computed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN service_catalog_admin_review_queue.candidate_suggestions IS
  'Ing-I (S133). Cached top-K candidate canonical slugs from the 2-pass
   resolver (trigram + Haiku semantic fallback). Format: [{ slug, name,
   description, concept_id, match_score, source: "trigram" | "haiku" }, ...].
   Populated on first /api/admin/review-queue/candidates fetch + persisted to
   avoid re-paying Haiku cost on subsequent renders. Stale-tolerant: cached
   value is valid forever from queue-row perspective (proposed_slug + label
   are immutable once enqueued; canonical vocabulary growth is the only
   refresh trigger, surfaced via stale_at heuristic at read time if needed).';

COMMENT ON COLUMN service_catalog_admin_review_queue.candidate_suggestions_computed_at IS
  'Ing-I (S133). When candidate_suggestions was last computed. Reserved for
   future cache invalidation logic when service_catalog grows enough that
   the cached suggestions may be stale relative to current vocabulary.';

ALTER TABLE service_catalog_admin_review_queue
  DROP CONSTRAINT IF EXISTS service_catalog_admin_review_queue_status_check;

ALTER TABLE service_catalog_admin_review_queue
  ADD CONSTRAINT service_catalog_admin_review_queue_status_check
  CHECK (status IN ('pending', 'promoted', 'rejected', 'merged'));

-- ============================================================================
-- SECTION 2 — trigram indexes on service_catalog (pg_trgm extension already
--             enabled via migs 007 + 014 + 113)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_service_catalog_slug_trgm
  ON service_catalog USING GIN (slug gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_service_catalog_name_trgm
  ON service_catalog USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_service_catalog_description_trgm
  ON service_catalog USING GIN (description gin_trgm_ops)
  WHERE description IS NOT NULL;

-- ============================================================================
-- SECTION 3 — RPC: find_service_catalog_candidates (Pass 1 trigram resolver)
-- ============================================================================
--
-- Returns top-K canonical service_catalog rows ranked by max trigram similarity
-- across (slug, name, description). Filters to canonical_for_concept=TRUE +
-- proposal_state='canonical' so aliases / proposed / deprecated / junk rows
-- never surface as candidates.
--
-- match_score = GREATEST(
--   similarity(slug, p_proposed_slug),
--   similarity(name, COALESCE(p_proposed_label, p_proposed_slug)),
--   similarity(COALESCE(description, ''), COALESCE(p_proposed_label, '')) * 0.5
-- )
-- Description contributes at 0.5 weight (description is longer + noisier than
-- slug/name; weight prevents description-coincidence false-matches).
-- ============================================================================

CREATE OR REPLACE FUNCTION find_service_catalog_candidates(
  p_proposed_slug TEXT,
  p_proposed_label TEXT DEFAULT NULL,
  p_top_k INTEGER DEFAULT 3,
  p_threshold NUMERIC DEFAULT 0.4
)
RETURNS TABLE(
  slug TEXT,
  name TEXT,
  description TEXT,
  concept_id UUID,
  match_score NUMERIC
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT
    sc.slug,
    sc.name,
    sc.description,
    sc.concept_id,
    GREATEST(
      similarity(sc.slug, p_proposed_slug),
      similarity(sc.name, COALESCE(p_proposed_label, p_proposed_slug)),
      similarity(COALESCE(sc.description, ''), COALESCE(p_proposed_label, '')) * 0.5
    )::NUMERIC AS match_score
  FROM service_catalog sc
  WHERE sc.canonical_for_concept = TRUE
    AND sc.proposal_state = 'canonical'
    AND sc.slug <> p_proposed_slug  -- never recommend self
    AND GREATEST(
      similarity(sc.slug, p_proposed_slug),
      similarity(sc.name, COALESCE(p_proposed_label, p_proposed_slug)),
      similarity(COALESCE(sc.description, ''), COALESCE(p_proposed_label, '')) * 0.5
    ) >= p_threshold
  ORDER BY match_score DESC
  LIMIT p_top_k;
END;
$$;

COMMENT ON FUNCTION find_service_catalog_candidates IS
  'Ing-I (S133). Pass 1 trigram resolver. Returns top-K canonical service_catalog
   rows ranked by max trigram similarity across (slug, name, description).
   Tunable via candidate_suggestions_config flag.config JSONB: trigram_threshold
   (p_threshold) + top_k (p_top_k). Pass 2 Haiku fallback fires from the
   application layer when this RPC returns <2 candidates OR top match_score <
   semantic_fallback_threshold (0.6 default).';

-- ============================================================================
-- SECTION 4 — RPC: merge_proposed_slug_into_canonical (atomic MERGE flow)
-- ============================================================================
--
-- Atomic MERGE in a single transaction with advisory lock per queue_id to
-- close the race condition between INSERT alias row in service_catalog +
-- UPDATE queue row to status='merged'.
--
-- Returns JSONB:
--   { "ok": true, "alias_slug": "<proposed>", "canonical_slug": "<target>" }
--   { "ok": false, "error": "<reason>" }
--
-- Error cases:
--   - 'queue_row_not_found': queue_id does not exist
--   - 'queue_row_not_pending': status already promoted/rejected/merged (race)
--   - 'canonical_not_found': p_canonical_slug does not exist OR is not canonical
--   - 'proposed_slug_collides': p_proposed_slug already in service_catalog
--                               (admin should use PROMOTE-as-existing OR REJECT)
-- ============================================================================

CREATE OR REPLACE FUNCTION merge_proposed_slug_into_canonical(
  p_queue_id UUID,
  p_canonical_slug TEXT,
  p_admin_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_queue_row service_catalog_admin_review_queue%ROWTYPE;
  v_canonical_row service_catalog%ROWTYPE;
  v_lock_key BIGINT;
BEGIN
  -- Advisory lock per queue_id to serialize concurrent MERGE attempts on same row
  v_lock_key := hashtext('ing_i_merge:' || p_queue_id::TEXT);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Lock + read queue row
  SELECT * INTO v_queue_row
  FROM service_catalog_admin_review_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'queue_row_not_found');
  END IF;

  IF v_queue_row.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'queue_row_not_pending', 'current_status', v_queue_row.status);
  END IF;

  -- Lookup canonical target
  SELECT * INTO v_canonical_row
  FROM service_catalog
  WHERE slug = p_canonical_slug
    AND canonical_for_concept = TRUE
    AND proposal_state = 'canonical';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'canonical_not_found', 'canonical_slug', p_canonical_slug);
  END IF;

  -- Check for proposed-slug collision (edge case: admin proposed slug that
  -- happens to already exist as a different canonical row)
  IF EXISTS (SELECT 1 FROM service_catalog WHERE slug = v_queue_row.proposed_service_slug) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'proposed_slug_collides',
      'proposed_slug', v_queue_row.proposed_service_slug,
      'hint', 'Use PROMOTE-as-existing OR REJECT-as-duplicate flow instead'
    );
  END IF;

  -- INSERT alias row in service_catalog
  -- (trigger enforce_canonical_per_concept() validates that v_canonical_row.concept_id
  -- exists + has the canonical sibling; this is guaranteed by our canonical lookup above)
  INSERT INTO service_catalog (
    slug,
    name,
    category,
    description,
    is_preventive_eligible,
    concept_id,
    canonical_for_concept,
    proposal_state
  ) VALUES (
    v_queue_row.proposed_service_slug,
    COALESCE(v_queue_row.proposed_service_label, v_canonical_row.name),
    v_canonical_row.category,
    v_canonical_row.description,
    v_canonical_row.is_preventive_eligible,
    v_canonical_row.concept_id,
    FALSE,                             -- this is the alias row, NOT canonical
    'alias'                            -- per mig 103 state machine
  );

  -- UPDATE queue row to status='merged'
  UPDATE service_catalog_admin_review_queue
  SET status = 'merged',
      resolved_service_slug = p_canonical_slug,
      reviewed_by_user_id = p_admin_user_id,
      reviewed_at = now()
  WHERE id = p_queue_id;

  RETURN jsonb_build_object(
    'ok', true,
    'alias_slug', v_queue_row.proposed_service_slug,
    'canonical_slug', p_canonical_slug,
    'concept_id', v_canonical_row.concept_id
  );

EXCEPTION WHEN OTHERS THEN
  -- Surface DB-side error to caller for diagnostic visibility (e.g., trigger
  -- enforce_canonical_per_concept fired unexpectedly)
  RETURN jsonb_build_object(
    'ok', false,
    'error', 'merge_exception',
    'sqlstate', SQLSTATE,
    'sqlerrm', SQLERRM
  );
END;
$$;

COMMENT ON FUNCTION merge_proposed_slug_into_canonical IS
  'Ing-I (S133). Atomic MERGE: admin picks canonical_slug from candidate panel
   for a pending queue row; this RPC (a) advisory-locks queue row, (b) verifies
   pending status + canonical exists + no proposed_slug collision, (c) INSERTs
   alias row in service_catalog (canonical_for_concept=FALSE, proposal_state=
   ''alias'', concept_id from canonical sibling), (d) UPDATEs queue row to
   status=''merged'' + resolved_service_slug=canonical + reviewed_*. Future
   parses of proposed_slug resolve to canonical via resolveCanonicalSlug()
   (mig 103 concept_id linkage). Returns JSONB {ok, ...} for caller dispatch.';

-- ============================================================================
-- SECTION 5 — Extend parse_cost_events.parser_kind enum (Cost-F architecture
--             compliance: Ing-I Haiku description-match calls write here)
-- ============================================================================

ALTER TABLE parse_cost_events
  DROP CONSTRAINT IF EXISTS parse_cost_events_parser_kind_check;

ALTER TABLE parse_cost_events
  ADD CONSTRAINT parse_cost_events_parser_kind_check
  CHECK (parser_kind IN (
    'sbc_base',
    'eoc_base',
    'plan_doc_base',
    'reparse_field',
    'reparse_field_batch',
    'card_scan',
    'bill_parse',
    'eob_parse',
    'admin_candidate_match'  -- Ing-I (S133) Pass 2 Haiku slug-disambiguation
  ));

-- ============================================================================
-- SECTION 6 — Feature flag seed (mirrors mig 075 INSERT shape per
--             feedback_candid_feature_flag_schema)
-- ============================================================================

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'candidate_suggestions_config',
  true,
  'Ing-I (S133). Tunable resolver config for /admin/review-queue candidate-slug suggestions. Pass 1 trigram threshold (trigram_threshold; safe range 0.3-0.6), Pass 2 Haiku semantic-match fallback floor (semantic_fallback_threshold; safe range 0.5-0.7), top-K candidates returned (top_k; safe range 2-5), Pass 2 minimum match score for surfacing (haiku_match_score_floor; safe range 0.4-0.7). Tune via UPDATE feature_flag_rules SET config = jsonb_set(config, ''{trigram_threshold}'', ''0.5'') WHERE flag_key=''candidate_suggestions_config''. Defaults calibrated as conservative starting points; observed false-positive merge rate should be <10% per Ship Gate G7 retrospective query at plans/queries/ing-i-decision-path.sql.',
  'global',
  '{"trigram_threshold": 0.4, "semantic_fallback_threshold": 0.6, "top_k": 3, "haiku_match_score_floor": 0.5}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
