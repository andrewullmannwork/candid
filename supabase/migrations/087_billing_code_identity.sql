-- Migration 087: S74.5 D1 — Code+Description Categorization Flywheel infrastructure
--
-- Per plans/s74.5_categorization_flywheel.md v2 (Session 82 LOCKs).
--
-- WHY THIS MIGRATION EXISTS
--
-- Today's bill parser uses a flat 3-char CPT prefix lookup at
-- src/lib/billing/parser.ts:80 that mis-categorizes Andrew's $146 preventive
-- overcharge and dozens of other codes. S74 hotfix #3 patched the obvious
-- prefix bugs (993→Preventive, 904/905/906/907 vaccines, F-codes, G-codes)
-- but the architecture remains brittle. The structural fix elevates
-- (billing_code, billing_code_type, description_signature) to first-class
-- identity and applies Pattern 1 #3 corroboration so the catalog grows from
-- EMAIL+PHONE-verified user uploads + corrections.
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. billing_code_identity table — composite-key UNIQUE on (code, code_type,
--    description_signature) per Pattern 2 P-2-extension architecture.
--    description_signature is free-text per Q1 LOCK (debuggable in admin queue;
--    collision-safe via composite UNIQUE). Promotion state mirrors Pattern 1 #3.
--
-- 2. mapping_promotion_events log — append-only audit trail per Pattern 1 #14
--    storage discipline. Shape mirrors canonical_promotion_events from mig 068
--    per Q4 LOCK.
--
-- 3. apply_mapping_promotion() Postgres function — atomic state transition
--    (proposed → corroborated OR admin_verified) with advisory lock per
--    composite key. service_role only (Pattern 1 #14 function-grant
--    enforcement).
--
-- 4. s74_5_categorization_flywheel_v1 feature flag (default OFF) — gates all
--    S74.5 user-facing behavior (composite-key parser path in D2/D4 + correction
--    modal in D6 + zero-cost-share audit-stage in D13 + claim-header arithmetic
--    in D15 + dispute auto-refresh in D16). Per feedback_feature_flags_required.
--    Mirrors S73.5 cf40_v4_algorithm one-flag-per-pillar pattern.
--
-- BACKOUT — flip flag OFF; legacy parser path resumes (categorizeProcedureCode
-- prefix lookup); new tables remain (additive per CLAUDE.md Rule #7).

BEGIN;

-- ============================================================================
-- SECTION 1: billing_code_identity table
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_code_identity (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_code              TEXT NOT NULL,
  billing_code_type         TEXT NOT NULL
    CHECK (billing_code_type IN ('CPT','HCPCS_L2','G_CODE','CAT_II','REV','NDC','DRG')),
  description_signature     TEXT NOT NULL,
  description_examples      TEXT[] NOT NULL DEFAULT '{}',
  service_slug              TEXT REFERENCES service_catalog(slug) ON DELETE SET NULL,

  promotion_state           TEXT NOT NULL DEFAULT 'proposed'
    CHECK (promotion_state IN ('proposed','corroborated','admin_verified')),
  confidence                NUMERIC NOT NULL DEFAULT 0.5
    CHECK (confidence BETWEEN 0 AND 1),
  distinct_user_count       INT NOT NULL DEFAULT 1
    CHECK (distinct_user_count >= 0),

  proposed_by_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,

  corroborator_sources      JSONB NOT NULL DEFAULT '[]'::jsonb,

  first_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_corroborated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_promotion_event_at   TIMESTAMPTZ,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (billing_code, billing_code_type, description_signature)
);

CREATE INDEX IF NOT EXISTS idx_billing_code_identity_code_type
  ON billing_code_identity (billing_code, billing_code_type);

CREATE INDEX IF NOT EXISTS idx_billing_code_identity_slug
  ON billing_code_identity (service_slug)
  WHERE service_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_code_identity_promotion_state
  ON billing_code_identity (promotion_state, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_billing_code_identity_proposer
  ON billing_code_identity (proposed_by_user_id, created_at DESC)
  WHERE proposed_by_user_id IS NOT NULL;

COMMENT ON TABLE billing_code_identity IS
  'S74.5 D1 (Session 82). Layer A — code+description identity table for billing-code-to-service-slug mappings. Composite UNIQUE on (billing_code, billing_code_type, description_signature) per Pattern 2 P-2-extension architecture. Promotion via Pattern 1 #3 (>=3 distinct EMAIL+PHONE users per Q2 LOCK) OR admin attestation (admin_verified bypass; cold-start lever per Pattern 1 #16). description_signature is free-text per Q1 LOCK (debuggable in admin queue; collision-safe via composite UNIQUE). Storage discipline per Pattern 1 #14: user corrections write here directly; promotion state advances via apply_mapping_promotion() Postgres function only.';

COMMENT ON COLUMN billing_code_identity.corroborator_sources IS
  'JSONB array of corroborator excerpts; each entry shape: {user_id_hash, raw_description, claim_line_item_id, recorded_at}. Top-K bounded (default 5; mirrors canonical_promotion_event_v1 sources_array_max_k). user_id_hash = sha256(user_id || identity_id) so cross-source dedup is possible without leaking user identities.';

ALTER TABLE billing_code_identity ENABLE ROW LEVEL SECURITY;

-- All end-user reads + writes flow through server-side API routes using the
-- service_role key (which bypasses RLS). The only explicit policy is for admin
-- access via the admin queue UI. Pattern matches mig 084 canonical_haiku_extractions.

CREATE POLICY "Admins SELECT all billing_code_identity"
  ON billing_code_identity FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.is_admin = true
    )
  );

CREATE POLICY "Admins UPDATE billing_code_identity"
  ON billing_code_identity FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.is_admin = true
    )
  );

-- Touch trigger for updated_at
CREATE TRIGGER billing_code_identity_updated_at
  BEFORE UPDATE ON billing_code_identity
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- SECTION 2: mapping_promotion_events (audit log)
-- ============================================================================

CREATE TABLE IF NOT EXISTS mapping_promotion_events (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_code_identity_id   UUID NOT NULL
    REFERENCES billing_code_identity(id) ON DELETE CASCADE,
  event_type                 TEXT NOT NULL CHECK (event_type IN (
    'first_promotion',         -- threshold met for first time; proposed -> corroborated; confidence 0.5 -> 0.9
    'corroboration_added',     -- additional corroborator on already-corroborated mapping; counter increment
    'admin_attested',          -- admin marks admin_verified; bypasses corroboration; confidence -> 1.0
    'admin_overridden'         -- admin manually changed slug or revoked promotion; forensic record
  )),
  fire_source                TEXT NOT NULL,         -- 'user-correction'|'bill-parse'|'admin-ui'|'backfill-script'
  distinct_user_count        INT NOT NULL,          -- cumulative count at fire time
  sources_count              INT NOT NULL,          -- count of excerpts in corroborator_sources at fire time
  promoted_slug              TEXT,                  -- the service_slug promoted (or replaced); NULL on admin_overridden revoke
  actor_user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  fired_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mapping_promotion_events_identity
  ON mapping_promotion_events (billing_code_identity_id, fired_at DESC);

CREATE INDEX IF NOT EXISTS idx_mapping_promotion_events_fired_at
  ON mapping_promotion_events (fired_at DESC);

COMMENT ON TABLE mapping_promotion_events IS
  'S74.5 D1 (Session 82). Append-only audit log for billing_code_identity promotion firings. Mirrors canonical_promotion_events shape from mig 068 per Pattern 1 #14 storage discipline + Q4 LOCK. One row per apply_mapping_promotion() call. Used for forensic audit (which user corrections corroborated this mapping?), admin UI surfaces (recent flywheel activity), telemetry on cold-start vs flywheel-driven promotions.';

ALTER TABLE mapping_promotion_events ENABLE ROW LEVEL SECURITY;

-- Admin SELECT only; INSERTs happen via apply_mapping_promotion() running as
-- service_role (RLS bypassed). Audit-log is append-only by design (no UPDATE
-- policy; admin reads only).

CREATE POLICY "Admins SELECT all mapping_promotion_events"
  ON mapping_promotion_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.is_admin = true
    )
  );

-- ============================================================================
-- SECTION 3: apply_mapping_promotion() Postgres function
-- ============================================================================
-- Atomic billing_code_identity state transition (proposed -> corroborated OR
-- proposed -> admin_verified) + log row insert. Advisory lock per composite
-- key prevents concurrent-promotion races. Mirrors mig 068
-- apply_promotion_event() pattern.

CREATE OR REPLACE FUNCTION apply_mapping_promotion(
  p_identity_id   UUID,
  p_new_state     TEXT,                       -- 'corroborated' | 'admin_verified'
  p_fire_source   TEXT,
  p_actor_user_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock_key       BIGINT;
  v_identity       billing_code_identity%ROWTYPE;
  v_new_confidence NUMERIC;
  v_event_type     TEXT;
  v_event_id       UUID := gen_random_uuid();
BEGIN
  IF p_new_state NOT IN ('corroborated','admin_verified') THEN
    RAISE EXCEPTION 'apply_mapping_promotion: invalid p_new_state %; expected corroborated or admin_verified', p_new_state;
  END IF;

  SELECT * INTO v_identity FROM billing_code_identity WHERE id = p_identity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_mapping_promotion: billing_code_identity row % not found', p_identity_id;
  END IF;

  v_lock_key := hashtextextended(
    'mapping_promotion:' || v_identity.billing_code || ':' || v_identity.billing_code_type || ':' || v_identity.description_signature,
    0
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Re-read under lock; state may have advanced while we waited.
  SELECT * INTO v_identity FROM billing_code_identity WHERE id = p_identity_id;

  IF p_new_state = 'admin_verified' THEN
    v_new_confidence := 1.0;
    v_event_type := 'admin_attested';
  ELSE
    v_new_confidence := 0.9;
    IF v_identity.confidence < 0.9 THEN
      v_event_type := 'first_promotion';
    ELSE
      v_event_type := 'corroboration_added';
    END IF;
  END IF;

  UPDATE billing_code_identity
  SET
    promotion_state         = p_new_state,
    confidence              = GREATEST(confidence, v_new_confidence),
    last_promotion_event_at = now(),
    last_corroborated_at    = now(),
    updated_at              = now()
  WHERE id = p_identity_id;

  INSERT INTO mapping_promotion_events (
    id, billing_code_identity_id, event_type, fire_source,
    distinct_user_count, sources_count, promoted_slug,
    actor_user_id, fired_at
  )
  VALUES (
    v_event_id,
    p_identity_id,
    v_event_type,
    p_fire_source,
    v_identity.distinct_user_count,
    jsonb_array_length(v_identity.corroborator_sources),
    v_identity.service_slug,
    p_actor_user_id,
    now()
  );

  RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION apply_mapping_promotion(UUID, TEXT, TEXT, UUID) IS
  'S74.5 D1 (Session 82). Atomic billing_code_identity state transition (proposed->corroborated OR proposed->admin_verified). Advisory lock per composite key (billing_code, billing_code_type, description_signature) prevents concurrent-promotion races. Service-role only (Pattern 1 #14 enforcement). Returns mapping_promotion_events row id. Confidence monotonic increasing (GREATEST never demotes). Mirrors apply_promotion_event() pattern from mig 068.';

GRANT EXECUTE ON FUNCTION apply_mapping_promotion(UUID, TEXT, TEXT, UUID) TO service_role;

-- ============================================================================
-- SECTION 4: claim_line_items extensions for D3/D6 conflict resolution
-- ============================================================================
-- billing_code_identity_id: direct FK so backfill query is one-index lookup
-- user_corrected_at: when user manually re-categorized this row
-- user_correction_locked_at: when user clicked "Revert to my choice" after a
--   community promotion landed a DIFFERENT slug (G4 LOCK sticky per-account)

ALTER TABLE claim_line_items
  ADD COLUMN IF NOT EXISTS billing_code_identity_id UUID
    REFERENCES billing_code_identity(id) ON DELETE SET NULL;

ALTER TABLE claim_line_items
  ADD COLUMN IF NOT EXISTS user_corrected_at TIMESTAMPTZ;

ALTER TABLE claim_line_items
  ADD COLUMN IF NOT EXISTS user_correction_locked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_claim_line_items_billing_code_identity
  ON claim_line_items (billing_code_identity_id)
  WHERE billing_code_identity_id IS NOT NULL;

COMMENT ON COLUMN claim_line_items.billing_code_identity_id IS
  'S74.5 D1 (Session 82). FK to billing_code_identity row that resolved this line items category. NULL when categorization fell back to legacy categorizeProcedureCode prefix lookup (pre-S74.5 rows) OR when composite-key returned no match. Promotion backfill (D3 backfillCorroboratedMapping) updates service_slug across all rows sharing this identity_id, except rows with user_correction_locked_at set.';

COMMENT ON COLUMN claim_line_items.user_corrected_at IS
  'S74.5 D5 (Session 82). Set when user manually re-categorized this line item via the correction modal. Distinct from user_correction_locked_at (which is set only after a community-conflict revert).';

COMMENT ON COLUMN claim_line_items.user_correction_locked_at IS
  'S74.5 D3/D6 (Session 82). Set when user clicks "Revert to my choice" in the conflict-resolution modal after community promotion landed a different slug. Locks this row against future community-driven slug overrides (G4 LOCK sticky per-account). User can still re-correct via the modal — locking applies only to passive backfill.';

-- ============================================================================
-- SECTION 5: feature flag seed
-- ============================================================================
-- s74_5_categorization_flywheel_v1 — gates ALL user-facing S74.5 behavior:
--   * Composite-key parser path (D2/D4): when OFF, legacy categorizeProcedureCode
--     prefix lookup only; when ON, signature lookup with legacy fallback
--   * CategoryCorrectionModal (D6): only renders when ON
--   * Zero-cost-share audit-stage (D13): only fires when ON
--   * Claim-header arithmetic audit (D15): only fires when ON
--   * Dispute evidence_fingerprint + auto-refresh (D16): only computed when ON
-- Mirrors S73.5 cf40_v4_algorithm one-flag-per-pillar pattern.

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  's74_5_categorization_flywheel_v1',
  false,
  'S74.5 (Session 82). Gates all user-facing categorization flywheel behavior: composite-key parser lookup (replaces flat-prefix categorizeProcedureCode), CategoryCorrectionModal on /claim, zero_cost_share_codes audit-stage (ACA preventive + ACIP vaccine BEFORE plan-coverage check), claim-header arithmetic audit (unallocated_balance finding type), dispute evidence_fingerprint + sent_letter immutability + cooldown-gated follow-up CTA. When OFF: legacy categorization + audit + dispute flow unchanged (pre-S74.5 behavior). When ON: full flywheel active. Sub-config: spam_throttle_per_minute (1) + spam_throttle_per_day (5) + unallocated_balance_threshold_cents (500 = $5; Q-D LOCK) + sent_dispute_cooldown_days (30; Q-M LOCK) + haiku_similarity_threshold (0.85; Q-A inline) + haiku_per_user_day_cap (100; Q6 LOCK).',
  'global',
  jsonb_build_object(
    'spam_throttle_per_minute', 1,
    'spam_throttle_per_day', 5,
    'unallocated_balance_threshold_cents', 500,
    'sent_dispute_cooldown_days', 30,
    'haiku_similarity_threshold', 0.85,
    'haiku_per_user_day_cap', 100,
    'promotion_threshold', 3,
    'sources_array_max_k', 5
  )
)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
