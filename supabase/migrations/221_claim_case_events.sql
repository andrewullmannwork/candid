-- =============================================================================
-- MIGRATION 221 — claim_case_events: the case-history event spine (S298)
-- + `case_timeline_v1` feature-flag seed
-- =============================================================================
--
-- Claim-vs-dispute timeline unification, Phase 0 (agenda:
-- plans/claim-vs-dispute-timeline-unification-agenda-2026-07-31.md §1, §0.9e).
--
-- WHAT: one append-only ledger of everything that HAPPENS on a claim's case —
-- letters drafted/sent/unsent/redrafted, responses logged, outcomes undone,
-- escalations, collections events, guided-step attestations, follow-ups sent,
-- deadline lapses, plan repins, finding dismissals, audit reruns. Mutable rows
-- (`dispute_outcomes` + friends) stay AUTHORITATIVE for CURRENT state; this
-- table is authoritative for HISTORY + SEQUENCE — the sequence that row
-- mutations destroy today (an audit rerun replaces auditSummary in place; an
-- unsend clears sent_at; a redraft overwrites the body).
--
-- Precedent: `plan_change_events`, `canonical_promotion_events` — same
-- pattern, same reasons. This table also SUBSUMES tracker Item N's planned
-- `dispute_letters_sent` lineage table (Andrew S298: "let the ledger be the
-- logbook; we should NOT build this twice") — per-version server-stamped
-- `letter_sent` events ARE the lineage.
--
-- WRITES: server-side only, at the existing mutation sites, through the
-- userScoped layer (B9) — fail-soft (a missed event loses a history line,
-- never corrupts state) and gated on `case_timeline_v1`. Payloads carry
-- REFERENCES ONLY (version ordinals, step ids, finding types, from/to ids):
-- never money (display pulls live values from rows), never note text
-- (`hasNote` boolean only — notes stay in row metadata), never PHI.
--
-- READS: none in Phase 0 (parity harness + backfill scripts only). Phase 1
-- wires the shared timeline projector; client access stays route-mediated
-- (RLS deny-all + REVOKE below, same posture as article_feedback mig 214).
--
-- `kind` is shape-checked, not enumerated: the closed v1 vocabulary (18
-- kinds) lives in src/lib/case/case-events.ts as a TS union — adding a
-- reserved kind later (case_closed, complaint_filed, document_attached) is a
-- code change, not a migration. `actor` IS enumerated (closed set by design).
--
-- APPLY (Studio, one paste): strip comments before pasting (Studio
-- silent-failure gotcha) + run the verify SELECTs after.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS claim_case_events;
--   DELETE FROM feature_flag_rules WHERE flag_key = 'case_timeline_v1';
--   (Flag OFF is the operational rollback: UPDATE feature_flag_rules
--    SET enabled = false WHERE flag_key = 'case_timeline_v1' — emitters go
--    quiet; existing events are inert data, untouched.)
-- =============================================================================

CREATE TABLE IF NOT EXISTS claim_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Nullable: claim-level events (guided phone steps, plan repins, audit
  -- reruns) have no dispute. SET NULL so history survives a dispute-row
  -- removal (append-only ethos); user/claim CASCADE covers erasure (E1–E4).
  dispute_id uuid REFERENCES dispute_outcomes(id) ON DELETE SET NULL,
  kind text NOT NULL
    CONSTRAINT claim_case_events_kind_shape
    CHECK (kind ~ '^[a-z0-9_]+$' AND char_length(kind) <= 48),
  actor text NOT NULL
    CONSTRAINT claim_case_events_actor_known
    CHECK (actor IN ('user', 'system', 'backfill')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The rail's read shape: one claim's history in order.
CREATE INDEX IF NOT EXISTS idx_claim_case_events_claim_occurred
  ON claim_case_events (claim_id, occurred_at);

-- Per-letter lineage (Item N's read shape) + erasure sweeps.
CREATE INDEX IF NOT EXISTS idx_claim_case_events_dispute
  ON claim_case_events (dispute_id) WHERE dispute_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_case_events_user
  ON claim_case_events (user_id);

-- Backfill idempotency: synthesized events derive deterministically from row
-- timestamps, so a re-run upserts into silence instead of duplicating.
-- COALESCE folds NULL dispute_id (claim-level events) into one bucket —
-- plain UNIQUE would treat NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_case_events_backfill
  ON claim_case_events (
    claim_id,
    kind,
    (COALESCE(dispute_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    occurred_at
  )
  WHERE actor = 'backfill';

ALTER TABLE claim_case_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE claim_case_events FROM anon, authenticated;

COMMENT ON TABLE claim_case_events IS
  'S298 Phase 0 — append-only case-history spine (timeline unification §1). Rows = history+sequence authority; dispute_outcomes stays current-state authority. Server-only writes at existing mutation sites via userScoped (B9), fail-soft, gated on case_timeline_v1. Payloads carry references only — no money, no note text, no PHI. Kind vocabulary (18, v1) lives in src/lib/case/case-events.ts. Subsumes tracker Item N (dispute_letters_sent). RLS enabled with no policies = deny all non-service access.';

INSERT INTO feature_flag_rules (flag_key, enabled, description, target_type, config)
VALUES (
  'case_timeline_v1',
  false,
  'S298 (2026-07-31). Claim-vs-dispute timeline unification — Phase 0: claim_case_events emitters at the existing mutation sites (generate / outcome / escalate / redraft / checklists / cron send-followups / letter PDF / repin / finding-dismiss / rerun-audit), fail-soft, zero UI. OFF = no event writes, byte-identical behavior. Later phases gate the projector-fed extended rail on /claim, the post-sent letter page flip, and the banner/email re-point.',
  'global',
  '{}'::jsonb
)
ON CONFLICT (flag_key) DO NOTHING;

-- =============================================================================
-- VERIFY (run after apply; expectations in brackets):
-- 1) Table + RLS:
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname = 'claim_case_events';                      -- [1 row, t]
-- 2) No anon/authenticated grants:
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'claim_case_events'
--      AND grantee IN ('anon','authenticated');                -- [0 rows]
-- 3) Indexes:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'claim_case_events';
--    -- [pkey + idx_claim_case_events_claim_occurred + idx_claim_case_events_dispute
--    --  + idx_claim_case_events_user + uq_claim_case_events_backfill]
-- 4) Flag seed:
--    SELECT flag_key, enabled, target_type, config FROM feature_flag_rules
--    WHERE flag_key = 'case_timeline_v1';    -- [1 row, false, global, {}]
-- =============================================================================
