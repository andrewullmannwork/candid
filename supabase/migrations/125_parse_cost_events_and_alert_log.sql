-- =============================================================================
-- MIGRATION 125 — Unified parse_cost_events ledger + cost_alert_log (Cost-F,
--                 pre-launch backend hardening)
-- =============================================================================
--
-- Adds the single source of truth for "how much did Candid spend on this
-- canonical / user / parser type." All cost-emitting paths (SBC base parse,
-- EOC base parse, plan_doc base parse, single-field reparse, batched
-- reparse, future card-scan / bill-parse / EOB / Layer 5 sampling) write
-- ONE row per parse to this table.
--
-- WHY THIS MIGRATION EXISTS
--
-- Per `plans/pre_launch_backend_hardening.md` block Cost-F: Ing-D.1 staged
-- rollout (CF-40 v4 flag flip to 5% canary) needs per-canonical cost
-- observability BEFORE flipping so we can detect runaway re-parse rates
-- on the 5% cohort.
--
-- The §5 spec said "query parse_audit_runs.cost_usd per canonical_plan_id",
-- but S129 Cost-F critical-pass found that approach was a bandaid:
--   1. parse_audit_runs (mig 055) has no canonical_plan_id column —
--      adding one would overload a table already serving Pattern P-7
--      fixture-harness telemetry with a 3-way `fixture_id` overload.
--   2. SBC base parse cost is NOT tracked in parse_audit_runs at all today.
--   3. UNION queries across parse_audit_runs + auto_reparse_field_frequencies
--      to aggregate cost are brittle; each future cost source needs a new
--      aggregation source added to Cost-F.
--
-- Long-term solution: unified `parse_cost_events` ledger. Every cost-emitting
-- path writes one row. Cost-F queries this table directly via simple
-- GROUP BY canonical_plan_id. Future cost types (card scan, bill parse,
-- future Layer 5 sampling) add a new `parser_kind` enum value + INSERT —
-- Cost-F query unchanged.
--
-- WHAT THIS MIGRATION ADDS
--
-- 1. parse_cost_events — append-only unified cost ledger. One row per parse.
--    All cost-emitting paths write here in parallel with their existing
--    telemetry (parse_audit_runs / auto_reparse_field_frequencies stay
--    populated for their own purposes; Cost-F reads ONLY from this table).
-- 2. cost_alert_log — append-only alert dedup log. One row per fired alert.
--    Cron checks this table to enforce 24h dedup window per (canonical_id,
--    alert_type) pair.
--
-- PARSER_KIND ENUM (extensible without schema change as new sources land)
--
--    'sbc_base'           — initial SBC parse via parseSBC / votedParseSBC
--    'eoc_base'           — initial EOC parse via parseEOC
--    'plan_doc_base'      — initial plan-doc parse (Haiku identity recovery)
--    'reparse_field'      — user-triggered single-field reparse
--    'reparse_field_batch'— batched reparse (Ing-A auto + user-triggered)
--    'card_scan'          — Haiku card scanner (future hookup)
--    'bill_parse'         — Bill parser (future hookup)
--    'eob_parse'          — EOB parser (future hookup)
--
-- COST_SOURCE ENUM (who triggered this parse)
--
--    'user_upload'        — user-initiated parse (typical case)
--    'auto_reparse'       — Ing-A triage hook (when flag flipped ON post-soak)
--    'admin_action'       — admin-triggered reparse via /admin/* surfaces
--    'cf40_v4_layer5'     — future Ing-D.1 Layer 5 sampling
--    'cf44_self_check'    — future Ing-H selective self-check fire
--
-- CANONICAL ATTRIBUTION
--
-- canonical_plan_id is NULLABLE because some parses happen BEFORE canonical
-- match (e.g., card scan resolves insurer before plan identity exists).
-- Aggregation queries filter to canonical_plan_id IS NOT NULL when computing
-- per-canonical cost; rows with NULL still contribute to per-user / per-doc
-- attribution.
--
-- WHY parse_audit_runs IS NOT REPLACED
--
-- parse_audit_runs serves Pattern P-7 fixture empirical harness telemetry
-- (recall + precision per fixture run). That role is orthogonal to PROD
-- cost ledger. Keeping both tables in parallel:
--   - parse_audit_runs continues serving harness + admin /admin/parse-audit-runs
--     queries that show recall/precision/cost-per-attempt for benchmarking
--   - parse_cost_events serves Cost-F + future per-canonical / per-user cost
--     attribution
-- Future cleanup (separate session, post-soak): deprecate parse_audit_runs
-- PROD writes from EOC + reparse paths once Cost-F has proven parity
-- coverage (≥7 days). See backend tracker §3 "Cost-G follow-up" placeholder.
--
-- BACKOUT — additive only. Both tables can be dropped; existing tables
-- untouched. No FKs added (loosely coupled per mig 120 / mig 124 pattern;
-- telemetry survives canonical / document / user deletion).

BEGIN;

-- ============================================================================
-- SECTION 1: parse_cost_events — unified cost ledger
-- ============================================================================

CREATE TABLE IF NOT EXISTS parse_cost_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Attribution (all soft references; no FKs)
  canonical_plan_id UUID,
  insurance_plan_id UUID,
  document_id UUID,
  user_id UUID,
  -- Classification
  parser_kind TEXT NOT NULL
    CHECK (parser_kind IN (
      'sbc_base',
      'eoc_base',
      'plan_doc_base',
      'reparse_field',
      'reparse_field_batch',
      'card_scan',
      'bill_parse',
      'eob_parse'
    )),
  cost_source TEXT NOT NULL
    CHECK (cost_source IN (
      'user_upload',
      'auto_reparse',
      'admin_action',
      'cf40_v4_layer5',
      'cf44_self_check'
    )),
  -- Cost
  cost_usd NUMERIC(8,5) NOT NULL,
  haiku_tokens_input INTEGER,
  haiku_tokens_output INTEGER,
  haiku_cache_read_tokens INTEGER DEFAULT 0,
  haiku_cache_create_tokens INTEGER DEFAULT 0,
  -- Per-parser specifics (field_name for reparse, section for SBC, etc.)
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-canonical aggregation: GROUP BY canonical_plan_id over time window
CREATE INDEX IF NOT EXISTS idx_pce_canonical_created_at
  ON parse_cost_events (canonical_plan_id, created_at DESC)
  WHERE canonical_plan_id IS NOT NULL;

-- Per-user aggregation: "this user is driving 80% of cost" surface
CREATE INDEX IF NOT EXISTS idx_pce_user_created_at
  ON parse_cost_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Per-parser-kind aggregation: "auto-reparse is X% of total cost"
CREATE INDEX IF NOT EXISTS idx_pce_kind_source_created_at
  ON parse_cost_events (parser_kind, cost_source, created_at DESC);

-- Time-range scans for daily cron aggregation
CREATE INDEX IF NOT EXISTS idx_pce_created_at
  ON parse_cost_events (created_at DESC);

COMMENT ON TABLE parse_cost_events IS
  'Cost-F (S129). Unified cost ledger — single source of truth for all Haiku spend per parse. One row per parse. All cost-emitting paths (sbc_base, eoc_base, plan_doc_base, reparse_field, reparse_field_batch + future card_scan, bill_parse, eob_parse) write here. Cost-F queries this table for per-canonical / per-user / per-parser aggregation. parse_audit_runs + auto_reparse_field_frequencies continue serving their own purposes (Pattern P-7 harness + Ing-A per-field calibration); parallel writes during transition period. No FKs — telemetry survives canonical / document / user deletion.';

COMMENT ON COLUMN parse_cost_events.canonical_plan_id IS
  'Canonical plan attribution. NULL when parse happens before canonical match (e.g., card scan resolving insurer before plan identity exists). Per-canonical aggregation queries filter to canonical_plan_id IS NOT NULL.';

COMMENT ON COLUMN parse_cost_events.insurance_plan_id IS
  'User-scoped insurance_plans row. NULL for parses outside upload flow (e.g., admin reprocess of a doc not yet bound to a plan).';

COMMENT ON COLUMN parse_cost_events.document_id IS
  'Source document. Always populated for upload-flow parses; NULL for admin-triggered standalone re-runs.';

COMMENT ON COLUMN parse_cost_events.user_id IS
  'User who owns the document. Used for per-user cost attribution (Cost-F future evolution: detect users driving disproportionate cost).';

COMMENT ON COLUMN parse_cost_events.parser_kind IS
  'What kind of parse this was. Extensible enum — new parser types add via CHECK constraint update (additive mig).';

COMMENT ON COLUMN parse_cost_events.cost_source IS
  'Who/what triggered this parse. Critical for runaway detection: auto_reparse + cf40_v4_layer5 are the high-risk runaway sources.';

COMMENT ON COLUMN parse_cost_events.cost_usd IS
  'Total Haiku spend for this parse in USD. Sum of all section / call costs that contributed to producing the parse output.';

COMMENT ON COLUMN parse_cost_events.metadata IS
  'Per-parser specifics. SBC: { sections_dispatched: [...] }. Reparse: { field_name, service_slug, sections_searched }. Card scan: { sides_scanned }. Etc.';

-- ============================================================================
-- SECTION 2: cost_alert_log — alert dedup
-- ============================================================================

CREATE TABLE IF NOT EXISTS cost_alert_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_plan_id UUID NOT NULL,
  alert_type TEXT NOT NULL
    CHECK (alert_type IN (
      'relative_spike',     -- 7d cost > 2x rolling 30d median
      'absolute_threshold'  -- 7d cost > $5
    )),
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cost_7d_usd NUMERIC(10,5) NOT NULL,
  baseline_30d_median_usd NUMERIC(10,5),
  slack_delivery_status TEXT NOT NULL
    CHECK (slack_delivery_status IN ('delivered', 'failed', 'skipped_no_webhook')),
  slack_response_code INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cal_canonical_fired
  ON cost_alert_log (canonical_plan_id, fired_at DESC);

CREATE INDEX IF NOT EXISTS idx_cal_fired
  ON cost_alert_log (fired_at DESC);

COMMENT ON TABLE cost_alert_log IS
  'Cost-F (S129). Alert dedup log. Cron checks "did we already alert on (canonical_id, alert_type) within last 24h" before firing Slack. Append-only forensic record of every alert evaluation that fired (including delivery failures). slack_delivery_status=skipped_no_webhook captures the case where SLACK_COST_ALERTS_WEBHOOK_URL env var is unset (alert engine still logs the breach for audit, just does not Slack-fire).';

COMMENT ON COLUMN cost_alert_log.alert_type IS
  'Which threshold breached. relative_spike = 7d cost > 2x rolling 30d median (catches low-baseline anomalies). absolute_threshold = 7d cost > $5 (catches high-volume canonicals). R9 refinement (both thresholds active; either fires alert).';

COMMENT ON COLUMN cost_alert_log.slack_delivery_status IS
  'delivered = Slack returned 2xx; failed = non-2xx or fetch threw; skipped_no_webhook = SLACK_COST_ALERTS_WEBHOOK_URL not set in env (alert recorded but not delivered — operator action needed).';

COMMIT;
