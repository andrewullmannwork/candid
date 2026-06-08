-- =============================================================================
-- MIGRATION 158 — ID-Block: canonical_promotion_quarantine + id_block_corroboration flag (S173)
-- =============================================================================
--
-- WHY (ID-Block corroboration source-independence — pre-launch H-risk, Session 173, PR2):
--   PR1 (mig 155) added the content fingerprint + the pure cluster-legitimacy scorer.
--   PR2 hooks the LIVE CF-40 Layer-3 promotion path (record-parse-event.ts). When a
--   cold_start/small promotion's corroboration cluster is SAME-CONTENT (a replayed
--   document, §3.4) OR targets a NOVEL canonical (§3.6) AND the cluster legitimacy is
--   below bar, the gate records the event here and — in active mode — WITHHOLDS the
--   doc-type promotion (quarantines the flywheel contribution; delayed-not-denied).
--   It NEVER rejects the user's own data (Pattern 1 #13). See
--   plans/id-block-corroboration-source-independence.md §3-§5 + §9.4/§9.5.
--
-- WHAT THIS MIGRATION ADDS (additive; no data change; Rule #7):
--   1. canonical_promotion_quarantine — the gate's record + the admin work-list queue.
--   2. id_block_corroboration flag seed (enabled=false → byte-identical; the gate never
--      runs). config carries the tunable gate thresholds (G6); empty here → code
--      defaults in DEFAULT_ID_BLOCK_CONFIG apply. config.gate.mode shadow (default) |
--      active. enabled=true + mode=shadow = log/record/Slack, HOLD NOTHING.
--
--   IDEMPOTENCY (mirrors mig 142 divergence-review): partial-unique on
--   (canonical_plan_id, document_type, value_tuple_key) WHERE state IN ('shadow','held')
--   — one LIVE row per distinct promotion cluster, refreshed (cluster grows) not
--   duplicated. The QStash parse pipeline retries + parallel workers parse the same
--   plan, so a naive insert would duplicate. A disposed row (cleared/promoted) lets a
--   re-emergence open a fresh row.
--
--   RLS: restricted backend-only table (admin tooling reads via service_role) — mirrors
--   the mig 144 pii_redaction_backfill_snapshot pattern (RLS + REVOKE anon/authenticated
--   + GRANT service_role).
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS canonical_promotion_quarantine;
--   DELETE FROM feature_flag_rules WHERE flag_key = 'id_block_corroboration';
-- =============================================================================

CREATE TABLE IF NOT EXISTS canonical_promotion_quarantine (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id   uuid NOT NULL,
  document_type       text NOT NULL,
  -- Stable key of the promoted identity tuple (the idempotency arbiter component).
  value_tuple_key     text NOT NULL,
  -- The promoted identity values (admin context).
  value_tuple_jsonb   jsonb NOT NULL,
  -- Cluster = the verified users whose latest upload voted the winning tuple.
  cluster_user_ids    uuid[] NOT NULL,
  content_fingerprints text[] NOT NULL,
  -- median per-user legitimacy (the gate value).
  cluster_score       numeric(6,4) NOT NULL,
  same_content        boolean NOT NULL,
  novel_canonical     boolean NOT NULL,
  -- {medianScore, uniformlyThin, temporalBurst, signupCorrelated}.
  shape_jsonb         jsonb NOT NULL,
  -- string[] of human-readable trigger reasons.
  trigger_reasons     jsonb NOT NULL,
  scale_tier          text NOT NULL,
  state               text NOT NULL CHECK (state IN ('shadow','held','cleared','promoted')),
  -- For held promotions — the PR3 daily re-eval cron (delayed-not-denied).
  next_eval_at        timestamptz,
  admin_decision      text CHECK (admin_decision IN ('confirm','clear','hold')),
  admin_decided_at    timestamptz,
  admin_decided_by    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One LIVE (shadow|held) row per distinct (canonical, doc_type, value-tuple) cluster.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_promotion_quarantine_live_uniq
  ON canonical_promotion_quarantine (canonical_plan_id, document_type, value_tuple_key)
  WHERE state IN ('shadow', 'held');

-- Re-eval sweep scan (PR3 cron): held rows ordered by next_eval_at.
CREATE INDEX IF NOT EXISTS canonical_promotion_quarantine_state_idx
  ON canonical_promotion_quarantine (state, next_eval_at);

COMMENT ON TABLE canonical_promotion_quarantine IS
  'ID-Block (S173): per-cluster record of the corroboration source-independence gate at CF-40 Layer-3 promotion. state shadow=logged-not-held | held=promotion withheld (delayed-not-denied) | cleared=admin/re-eval cleared | promoted=allowed. NEVER touches the user''s own data (Pattern 1 #13). Restricted: service_role only.';

-- Restricted backend-only table (mirrors mig 144 snapshot).
ALTER TABLE canonical_promotion_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON canonical_promotion_quarantine FROM anon, authenticated;
GRANT ALL ON canonical_promotion_quarantine TO service_role;

-- Master gate flag (default OFF → gate never runs → byte-identical promotion).
INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'id_block_corroboration',
  false,
  'ID-Block (S173). Gates the corroboration source-independence check at CF-40 Layer-3 promotion at cold_start/small. enabled=false means the gate never runs (byte-identical). enabled=true with gate.mode shadow logs and Slacks but holds nothing, while active withholds a flagged promotion (quarantines the contribution, never the user data). Triggers: same-content replay or novel-canonical, AND cluster legitimacy below threshold. All weights and thresholds tunable via config JSONB (G6, see DEFAULT_ID_BLOCK_CONFIG). Slack Fraud/Spam C0B8MQL9CQ6.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;
