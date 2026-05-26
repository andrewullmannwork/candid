-- Ing-I (S133) decision-path retrospective query.
-- Per Ship Gate G7: captures BOTH fire path (MERGE / PROMOTE / REJECT) and
-- non-fire path (REJECT despite high-confidence candidate available).
--
-- Run periodically (monthly default per G7 soak; cadence tightens if
-- false-positive rate >10%) to validate the Opus item I target:
--   "≥30% of admin decisions use MERGE-INTO when top-K candidates surface
--    with match_score ≥ 0.6"
--
-- And the Ing-I §6 verification floor:
--   "Admin retrospective audit on first 50 MERGE actions shows ≥90% correct
--    merges (no false consolidations)"
--
-- Usage:
--   psql "$DATABASE_URL" -f plans/queries/ing-i-decision-path.sql
-- Or paste sections individually into Supabase Studio SQL editor.

-- =========================================================================
-- 1. Status distribution over rolling 30d (G7 fire-path summary)
-- =========================================================================

SELECT
  status,
  COUNT(*) AS n,
  ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct
FROM service_catalog_admin_review_queue
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY status
ORDER BY n DESC;

-- Interpretation:
--   - status='merged' / status='promoted' / status='rejected' counts are
--     the 3 admin actions for slugs.
--   - status='pending' = backlog.
--   - Target ratio: merged ≥ 30% of (promoted + merged + rejected) when
--     candidates ≥ 0.6 are available (see query 3).

-- =========================================================================
-- 2. Match-score histogram of cached candidate_suggestions
-- =========================================================================
--
-- Distribution of TOP candidate match_score across pending + resolved rows.
-- Tells us how often the resolver finds a strong candidate.

WITH top_scores AS (
  SELECT
    id,
    status,
    (candidate_suggestions->0->>'match_score')::numeric AS top_score
  FROM service_catalog_admin_review_queue
  WHERE candidate_suggestions IS NOT NULL
    AND jsonb_array_length(candidate_suggestions) > 0
    AND created_at > NOW() - INTERVAL '30 days'
)
SELECT
  CASE
    WHEN top_score >= 0.8 THEN 'A: 0.8-1.0 (strong)'
    WHEN top_score >= 0.6 THEN 'B: 0.6-0.79 (plausible)'
    WHEN top_score >= 0.4 THEN 'C: 0.4-0.59 (weak)'
    ELSE 'D: <0.4 (no real match)'
  END AS score_bucket,
  COUNT(*) AS n
FROM top_scores
GROUP BY 1
ORDER BY 1;

-- =========================================================================
-- 3. MERGE-INTO usage rate when high-confidence candidate available
-- =========================================================================
--
-- THE KEY G7 SIGNAL: "≥30% of decisions use MERGE-INTO when top-K candidates
-- surface with match_score ≥ 0.6"
--
-- numerator   = decisions with high-conf candidate that resulted in 'merged'
-- denominator = decisions with high-conf candidate that resulted in any
--               action ('merged' OR 'promoted' OR 'rejected')

WITH decisions_with_high_conf_candidate AS (
  SELECT
    id,
    status,
    (candidate_suggestions->0->>'match_score')::numeric AS top_score
  FROM service_catalog_admin_review_queue
  WHERE candidate_suggestions IS NOT NULL
    AND jsonb_array_length(candidate_suggestions) > 0
    AND (candidate_suggestions->0->>'match_score')::numeric >= 0.6
    AND status IN ('merged', 'promoted', 'rejected')
    AND created_at > NOW() - INTERVAL '30 days'
)
SELECT
  COUNT(*) FILTER (WHERE status = 'merged') AS n_merged,
  COUNT(*) FILTER (WHERE status = 'promoted') AS n_promoted,
  COUNT(*) FILTER (WHERE status = 'rejected') AS n_rejected,
  COUNT(*) AS n_total,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status = 'merged') / NULLIF(COUNT(*), 0),
    1
  ) AS pct_merge_rate
FROM decisions_with_high_conf_candidate;

-- Target: pct_merge_rate ≥ 30%.
-- If < 30%: candidates surfaced are not the right ones (tune thresholds OR
-- improve Pass 2 prompt). If > 80%: thresholds too aggressive (admin
-- rubber-stamping; raise floor to force more deliberate review).

-- =========================================================================
-- 4. "REJECTED despite high-confidence candidate" — silent regression check
-- =========================================================================
--
-- Per G7 non-fire-path: capture cases where admin REJECTED a row even
-- though the resolver had a >= 0.6 candidate available. Each such case
-- represents either:
--   (a) admin judgment that the resolver was wrong (good — admin override)
--   (b) admin missed the MERGE option (UX failure)
--   (c) admin couldn't tell from candidate panel whether to merge (UX failure)
--
-- Manual review of first 5-10 such rows surfaces which cause is dominant.

SELECT
  id,
  proposed_service_slug,
  proposed_service_label,
  (candidate_suggestions->0->>'slug') AS top_candidate_slug,
  (candidate_suggestions->0->>'match_score')::numeric AS top_score,
  (candidate_suggestions->0->>'source') AS top_source,
  rejection_reason,
  reviewed_at
FROM service_catalog_admin_review_queue
WHERE status = 'rejected'
  AND candidate_suggestions IS NOT NULL
  AND jsonb_array_length(candidate_suggestions) > 0
  AND (candidate_suggestions->0->>'match_score')::numeric >= 0.6
  AND created_at > NOW() - INTERVAL '30 days'
ORDER BY top_score DESC
LIMIT 20;

-- =========================================================================
-- 5. MERGE retrospective audit (first 50 MERGE actions)
-- =========================================================================
--
-- Per Ing-I §6 verification: ≥90% of MERGE actions should be CORRECT merges
-- (no false consolidations).
--
-- Manual review by Andrew: for each row below, inspect proposed_service_slug
-- vs resolved_service_slug + sample the resulting aliased slug's usage in
-- canonical_plan_services to confirm semantic correctness.
--
-- If false-positive rate > 10%: raise candidate_suggestions_config thresholds
-- (UPDATE feature_flag_rules SET config = jsonb_set(config, '{trigram_threshold}', '0.5')
--  WHERE flag_key = 'candidate_suggestions_config').

SELECT
  q.id,
  q.proposed_service_slug,
  q.proposed_service_label,
  q.resolved_service_slug AS merged_into,
  -- The alias service_catalog row created at MERGE time
  (SELECT created_at FROM service_catalog WHERE slug = q.proposed_service_slug AND proposal_state = 'alias') AS alias_created_at,
  q.reviewed_at,
  q.reviewed_by_user_id
FROM service_catalog_admin_review_queue q
WHERE q.status = 'merged'
ORDER BY q.reviewed_at ASC
LIMIT 50;

-- =========================================================================
-- 6. parse_cost_events summary for admin_candidate_match (Cost-F observability)
-- =========================================================================
--
-- Tracks Pass 2 Haiku description-match spend. Should be bounded by the
-- count of pending rows that triggered Pass 2 (each pays ~$0.005). Sanity
-- check: monthly total should be << $5 at pre-launch volume.

SELECT
  COUNT(*) AS n_haiku_calls,
  ROUND(SUM(cost_usd)::numeric, 4) AS total_cost_usd,
  ROUND(AVG(cost_usd)::numeric, 5) AS avg_cost_usd,
  MIN(created_at) AS first_call,
  MAX(created_at) AS last_call
FROM parse_cost_events
WHERE parser_kind = 'admin_candidate_match'
  AND created_at > NOW() - INTERVAL '30 days';
