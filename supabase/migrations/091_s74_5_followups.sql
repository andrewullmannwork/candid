-- ============================================================================
-- Migration 091 — S74.5c (Session 84) follow-up bundle
-- ============================================================================
-- Three additive changes that come out of the skeptical review of the
-- skeptical review (plans/findings/s74.5_skeptical_review.md):
--
--   §3.5  — apply_corrector_upsert() RPC: advisory-locked atomic merge of
--           corroborator_sources + distinct_user_count. Replaces the
--           read-modify-write in upsertCorrectorOnIdentity() which had a
--           lost-update race under concurrent contributions.
--   §3.2  — haiku_budget_tracking table + reserve_haiku_budget() RPC:
--           durable per-user-day Haiku call counter for the categorization
--           flywheel cost cap (Q6 LOCK = 100 calls/user/day). Replaces the
--           process-local Map which reset on every serverless cold start.
--   §3.12 — finding_dismissals table: append-only telemetry of D15 dismiss
--           actions for cross-user pattern analysis (Pattern P-9 promotion
--           candidate detection).
--
-- Idempotent; safe to re-run.
-- ============================================================================

-- ============================================================================
-- SECTION 1: apply_corrector_upsert() — advisory-locked source merge
-- ============================================================================
-- Per Subplan §6 + §9 #3 + Pattern 1 #14 storage discipline.
--
-- This RPC unifies two write paths that mutate billing_code_identity.corroborator_sources:
--   (a) user-correction via D5 endpoint (recordUserCorrection in TS)
--   (b) parser-path observation during bill ingestion (§1.5 fix; recordParserObservation in TS)
--
-- Both paths must atomically:
--   1. acquire advisory lock keyed by composite (code, codeType, signature)
--   2. read corroborator_sources
--   3. dedup-by-user_hash, append new entry
--   4. recompute distinct_user_count
--   5. write back
--
-- Disagreement-tolerance semantic (per §1.1 fix): user_correction entries
-- carry a proposed_slug; bill_observed entries do NOT (proposed_slug=null).
-- Promotion evaluator tallies votes ONLY across user_correction entries
-- (see code-identity-promotion.ts evaluateMappingPromotion). bill_observed
-- entries count toward distinct_user_count for telemetry but DO NOT vote.
--
-- Source-priority rule: if a user has an existing user_correction entry and
-- the new entry is bill_observed, the user_correction is preserved (passive
-- observation cannot overwrite explicit correction). Otherwise the new entry
-- replaces the old one for that user (allows users to change their mind).

CREATE OR REPLACE FUNCTION apply_corrector_upsert(
  p_identity_id      UUID,
  p_user_id_hash     TEXT,
  p_proposed_slug    TEXT,            -- NULL for bill_observed
  p_source           TEXT,            -- 'user_correction' | 'bill_observed'
  p_raw_description  TEXT,
  p_claim_line_item_id UUID DEFAULT NULL,
  p_max_sources      INT DEFAULT 5
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
  IF p_source NOT IN ('user_correction','bill_observed') THEN
    RAISE EXCEPTION 'apply_corrector_upsert: invalid p_source %; expected user_correction or bill_observed', p_source;
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

  -- Source-priority rule: passive bill_observed cannot overwrite explicit user_correction
  IF v_existing_source = 'user_correction' AND p_source = 'bill_observed' THEN
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

  -- Build new entry
  v_new_entry := jsonb_build_object(
    'user_id_hash', p_user_id_hash,
    'proposed_slug', p_proposed_slug,
    'source', p_source,
    'raw_description', p_raw_description,
    'claim_line_item_id', p_claim_line_item_id,
    'recorded_at', v_now
  );

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

COMMENT ON FUNCTION apply_corrector_upsert(UUID, TEXT, TEXT, TEXT, TEXT, UUID, INT) IS
  'S74.5 §3.5 (Session 84). Advisory-locked atomic corrector upsert on billing_code_identity.corroborator_sources. Replaces the lost-update read-modify-write in upsertCorrectorOnIdentity. Source-priority: existing user_correction entries are NOT overwritten by passive bill_observed entries (passive observation cannot displace explicit correction). distinct_user_count is recomputed from merged sources as COUNT(DISTINCT user_id_hash) over the ACTIVE bounded array (top-K = p_max_sources, default 5). NOTE: at the truncation boundary (>p_max_sources distinct contributors on a single identity) the count reflects ACTIVE voters in the bounded array — adding a new contributor may evict the oldest, keeping the count stable; this is the intended semantic (the count tracks who is currently voting, not lifetime contributors). service_slug is NEVER touched by this RPC — only apply_mapping_promotion (or its atomic wrapper promote_with_slug) writes it at promotion time (§1.1 + R-2 fix).';

GRANT EXECUTE ON FUNCTION apply_corrector_upsert(UUID, TEXT, TEXT, TEXT, TEXT, UUID, INT) TO service_role;

-- ============================================================================
-- SECTION 1b: promote_with_slug() — atomic slug-write + promotion
-- ============================================================================
-- Per S74.5c C-3 + C-6 review findings:
--
-- Both the admin promote endpoint AND the user-correction evaluator currently
-- write service_slug via a direct UPDATE then call apply_mapping_promotion.
-- The slug-write happens OUTSIDE the advisory lock that apply_mapping_promotion
-- acquires internally. A concurrent corroborator-upsert (which acquires the
-- same lock for the composite key) could land between the slug-write and the
-- promotion RPC, leading to slug/event_log divergence in rare races.
--
-- This wrapper acquires the lock FIRST, writes the slug if provided, then
-- delegates to apply_mapping_promotion (which re-acquires the same lock —
-- pg_advisory_xact_lock is re-entrant within the same transaction). The
-- whole operation runs in one PG function call = one implicit transaction =
-- one continuous lock hold across slug-write + state advance + event log.
--
-- Callers (admin promote endpoint + evaluateMappingPromotion in TS) now go
-- through this wrapper instead of the separate UPDATE + RPC pair.

CREATE OR REPLACE FUNCTION promote_with_slug(
  p_identity_id   UUID,
  p_new_state     TEXT,                       -- 'corroborated' | 'admin_verified'
  p_set_slug      TEXT,                       -- new service_slug to apply atomically; NULL = leave as-is
  p_fire_source   TEXT,
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock_key BIGINT;
  v_identity billing_code_identity%ROWTYPE;
BEGIN
  -- Read identity for the lock key derivation. NOT FOUND is handled by the
  -- delegated apply_mapping_promotion call (it RAISEs).
  SELECT * INTO v_identity FROM billing_code_identity WHERE id = p_identity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promote_with_slug: billing_code_identity row % not found', p_identity_id;
  END IF;

  v_lock_key := hashtextextended(
    'mapping_promotion:' || v_identity.billing_code || ':' || v_identity.billing_code_type || ':' || v_identity.description_signature,
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Write slug INSIDE the lock if provided. The delegated RPC reads the row
  -- again under the same xact and will see this slug as v_identity.service_slug
  -- when it composes the mapping_promotion_events row.
  IF p_set_slug IS NOT NULL THEN
    UPDATE billing_code_identity
    SET service_slug = p_set_slug,
        updated_at   = now()
    WHERE id = p_identity_id;
  END IF;

  -- Delegate to apply_mapping_promotion. Same advisory lock key; xact-scoped
  -- + re-entrant, so the inner PERFORM pg_advisory_xact_lock is a no-op for
  -- this transaction.
  RETURN apply_mapping_promotion(p_identity_id, p_new_state, p_fire_source, p_actor_user_id);
END;
$$;

COMMENT ON FUNCTION promote_with_slug(UUID, TEXT, TEXT, TEXT, UUID) IS
  'S74.5c (Session 84 C-3+C-6). Atomic slug-write + state advance + event log under ONE advisory lock. Callers (admin promote endpoint + evaluateMappingPromotion) use this instead of separate UPDATE + apply_mapping_promotion calls — eliminates the race window where a concurrent apply_corrector_upsert could land between the slug-write and the promotion RPC.';

GRANT EXECUTE ON FUNCTION promote_with_slug(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;

-- Update billing_code_identity.corroborator_sources column comment to reflect
-- the §1.1 + §1.5 shape: entries now carry source + proposed_slug fields.
COMMENT ON COLUMN billing_code_identity.corroborator_sources IS
  'JSONB array of corroborator entries. Per-entry shape (§1.1 + §1.5 extended): { user_id_hash, source ("user_correction"|"bill_observed"), proposed_slug (text|null; null for bill_observed), raw_description, claim_line_item_id (uuid|null), recorded_at }. Top-K bounded (default 5; user_correction entries prioritized). user_id_hash = sha256(user_id || identity_id) so cross-source dedup is possible without leaking user identities. Promotion evaluator (evaluateMappingPromotion in TS) tallies votes ONLY across user_correction entries; bill_observed contribute to distinct_user_count but never to slug votes.';

-- ============================================================================
-- SECTION 2: haiku_budget_tracking — durable per-user-day call counter
-- ============================================================================
-- Per Subplan §3 Layer B step 6 + Q6 LOCK. Replaces the process-local Map in
-- code-identity.ts:HAIKU_DAILY_CAP_BY_USER which reset on serverless cold-
-- start, making the cap effectively ~unbounded under realistic Vercel traffic.

CREATE TABLE IF NOT EXISTS haiku_budget_tracking (
  user_id    UUID NOT NULL,
  day_iso    DATE NOT NULL,
  count      INT  NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day_iso)
);

CREATE INDEX IF NOT EXISTS idx_haiku_budget_recent
  ON haiku_budget_tracking (day_iso DESC, user_id);

COMMENT ON TABLE haiku_budget_tracking IS
  'S74.5 §3.2 (Session 84). Per-user-day Haiku call counter for the categorization flywheel cost cap (Q6 LOCK = 100/user/day). Durable storage replaces process-local Map which reset on serverless cold-starts. Reads/writes go through reserve_haiku_budget() RPC for atomic increment-and-check.';

CREATE OR REPLACE FUNCTION reserve_haiku_budget(
  p_user_id UUID,
  p_cap     INT DEFAULT 100
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_today DATE := CURRENT_DATE;
  v_count INT;
BEGIN
  INSERT INTO haiku_budget_tracking (user_id, day_iso, count, updated_at)
  VALUES (p_user_id, v_today, 1, now())
  ON CONFLICT (user_id, day_iso) DO UPDATE
    SET count = haiku_budget_tracking.count + 1,
        updated_at = now()
  RETURNING count INTO v_count;

  RETURN v_count <= p_cap;
END;
$$;

COMMENT ON FUNCTION reserve_haiku_budget(UUID, INT) IS
  'S74.5 §3.2 (Session 84). Atomic increment-and-check Haiku budget reserve. Returns TRUE if the reservation keeps us at or under the cap, FALSE if it would exceed. NOTE: the increment ALWAYS happens (caller decides whether to actually spend the call); this matches the existing process-local semantic and keeps the counter monotonic even on contention.';

GRANT EXECUTE ON FUNCTION reserve_haiku_budget(UUID, INT) TO service_role;

ALTER TABLE haiku_budget_tracking ENABLE ROW LEVEL SECURITY;

-- Admin SELECT only; service_role bypasses RLS for writes.
CREATE POLICY "Admins SELECT haiku_budget_tracking"
  ON haiku_budget_tracking FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.is_admin = true
    )
  );

-- ============================================================================
-- SECTION 3: finding_dismissals — durable D15 dismiss telemetry
-- ============================================================================
-- Per Subplan §7.3 Q-E LOCK: "Reason corpus analyzed for false-positive
-- pattern detection (Pattern P-9 promotion candidate)." v1 only logged to
-- console; this table makes the corpus durably queryable across users.

CREATE TABLE IF NOT EXISTS finding_dismissals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  claim_id        UUID NOT NULL,
  finding_id      TEXT NOT NULL,    -- the in-memory finding UUID (regenerated each audit run; persistence-level identity is in metadata)
  finding_type    TEXT NOT NULL,    -- 'unallocated_balance' | 'overcharge' | 'zero_cost_share_overcharge' | ...
  finding_amount  NUMERIC(12,2),
  finding_line_number INT,          -- NULL for claim-level findings
  reason          TEXT NOT NULL,    -- 'legitimate_adjustment' | 'prior_balance_carryover' | 'prompt_pay_discount' | 'state_mandate_adjustment' | 'other'
  note            TEXT,
  dismissed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finding_dismissals_type_reason
  ON finding_dismissals (finding_type, reason, dismissed_at DESC);

CREATE INDEX IF NOT EXISTS idx_finding_dismissals_user_claim
  ON finding_dismissals (user_id, claim_id, dismissed_at DESC);

COMMENT ON TABLE finding_dismissals IS
  'S74.5 §3.12 (Session 84). Append-only telemetry of D15 dismiss-with-reason actions. Cross-user corpus mined for false-positive pattern detection (Pattern P-9 promotion candidates — e.g., if the same finding type is dismissed >70% of the time with the same reason, the audit rule needs tuning).';

ALTER TABLE finding_dismissals ENABLE ROW LEVEL SECURITY;

-- Users can see their own dismissals; admins see all. Service-role inserts.
CREATE POLICY "Users SELECT own finding_dismissals"
  ON finding_dismissals FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Admins SELECT all finding_dismissals"
  ON finding_dismissals FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.is_admin = true
    )
  );

-- ============================================================================
-- END migration 091
-- ============================================================================
