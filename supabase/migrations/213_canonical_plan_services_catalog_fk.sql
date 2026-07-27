-- =============================================================================
-- MIGRATION 213 — canonical_plan_services ⇄ service_catalog: the missing FK
-- (S289 — plan-flow unification arc; root cause of the "every search-selected
-- plan renders as Other Services" defect)
-- =============================================================================
--
-- WHY: mig 019:104 declared `service_slug TEXT` with a comment claiming
-- "FK to service_catalog for backward compat" — the constraint was never
-- created. Every canonical reader has re-derived category/name by hand since
-- (three divergent answers; /api/plan/analyze's gap-fill gave up and hardcoded
-- category:'other'). This migration adds the real constraint + write-time
-- concept stamping so identity lives at the table boundary.
--
-- Verified preconditions (DEV = PROD clone, 2026-07-27):
--   * service_catalog.slug is NOT NULL UNIQUE (mig 009) — valid FK target.
--   * canonical_plan_services: 54,600 rows, 0 NULL service_slug, 100.00%
--     resolve in service_catalog → the FK VALIDATEs with zero repairs.
--     (Step 1 is a CORRECTNESS repair, not an FK precondition — merged
--     catalog rows keep their slug row, so dead-slug references still pass.)
--   * 5-col unique key = uq_canonical_plan_service
--     (canonical_plan_id, service_slug, place_of_service, component,
--     plan_tier_label) — plain UNIQUE constraint, no expression/partial index.
--   * Existing BEFORE triggers on cps (align_dualwrite — dormant mig-173 net;
--     confidence_recompute) neither read nor write service_slug/concept_id;
--     alphabetical ordering puts the new stamp trigger last. No interaction.
--
-- APPLY (Studio, one paste, off-peak): strip comments before pasting (Studio
-- silent-failure gotcha) + run the verify SELECTs after. Step 2 row-locks
-- ~53.6k rows for ~a second against the live promotion RPC.
-- Sequencing vs deploy: apply BEFORE promoting the S289 code deploy. Old code
-- is unaffected (it hardcodes 'other' regardless); new code tolerates either
-- order, but mig-first removes a transient double-render window on the 7
-- remapped rows.
--
-- ROLLBACK:
--   ALTER TABLE canonical_plan_services
--     DROP CONSTRAINT IF EXISTS canonical_plan_services_service_slug_fkey;
--   DROP TRIGGER IF EXISTS stamp_cps_concept_id ON canonical_plan_services;
--   DROP FUNCTION IF EXISTS stamp_cps_concept_id();
--   -- Steps 1-2 are data repairs (no reversal): step 1 re-expresses the same
--   -- benefit at its mig-183 identity (telehealth_* → live slug @ virtual);
--   -- step 2 fills NULLs only.
-- =============================================================================

-- ── Step 1 — remap the 7 stored dead-slug rows to their mig-183 identity ─────
-- telehealth_pcp → pcp_visit @ place_of_service='virtual'
-- telehealth_specialist → specialist_visit @ place_of_service='virtual'
-- (mig 183:20-23 declares exactly this identity; the rows are admin_attested
-- $0-telehealth cells and MUST NOT be deleted — every one has a live-slug
-- incumbent at place='any', so a slug-only remap would collide and lose them.
-- At place='virtual' there are zero incumbents (verified). The NOT EXISTS
-- guard makes the statement a safe no-op for any row whose virtual cell is
-- occupied by PROD-apply time; leftovers stay valid under the FK and are
-- reported by verify SELECT #4.)

UPDATE canonical_plan_services cps
SET service_slug = 'pcp_visit',
    place_of_service = 'virtual',
    updated_at = now()
WHERE cps.service_slug = 'telehealth_pcp'
  AND NOT EXISTS (
    SELECT 1 FROM canonical_plan_services t
    WHERE t.canonical_plan_id = cps.canonical_plan_id
      AND t.service_slug = 'pcp_visit'
      AND t.place_of_service = 'virtual'
      AND t.component = cps.component
      AND t.plan_tier_label = cps.plan_tier_label
  );

UPDATE canonical_plan_services cps
SET service_slug = 'specialist_visit',
    place_of_service = 'virtual',
    updated_at = now()
WHERE cps.service_slug = 'telehealth_specialist'
  AND NOT EXISTS (
    SELECT 1 FROM canonical_plan_services t
    WHERE t.canonical_plan_id = cps.canonical_plan_id
      AND t.service_slug = 'specialist_visit'
      AND t.place_of_service = 'virtual'
      AND t.component = cps.component
      AND t.plan_tier_label = cps.plan_tier_label
  );

-- ── Step 2 — backfill concept_id from the catalog (write-side gap repair) ────
-- The cold-start seed's writer (apply_promotion_event) has no concept_id arm →
-- 53,639/54,600 rows NULL. service_catalog.concept_id is 101/102 populated
-- (the one NULL is the merged 'dme' alias with zero cps rows). Runs AFTER
-- step 1 so the 7 remapped rows stamp with their LIVE slug's concept.
-- (Fires the existing BEFORE triggers as no-ops; does NOT fire the new stamp
-- trigger — that is created afterwards and only watches INSERT / UPDATE OF
-- service_slug.)

UPDATE canonical_plan_services cps
SET concept_id = sc.concept_id
FROM service_catalog sc
WHERE sc.slug = cps.service_slug
  AND cps.concept_id IS NULL
  AND sc.concept_id IS NOT NULL;

-- ── Step 3 — the FK itself ───────────────────────────────────────────────────
-- NO ACTION both directions (matches the existing service_catalog(slug) FK
-- precedent, mig 087): catalog rows are never deleted in practice — refusing
-- deletion-while-referenced is honest; slug renames are migration-only events
-- (the merge pattern sets merged_into_id instead of renaming), and a CASCADE
-- could silently rewrite thousands of rows / abort on 5-col collisions.
-- NOT VALID + VALIDATE keeps intent explicit; in a single Studio transaction
-- the lock profile is equivalent (54.6k rows validate sub-second).

ALTER TABLE canonical_plan_services
  ADD CONSTRAINT canonical_plan_services_service_slug_fkey
  FOREIGN KEY (service_slug) REFERENCES service_catalog(slug)
  ON UPDATE NO ACTION ON DELETE NO ACTION
  NOT VALID;

ALTER TABLE canonical_plan_services
  VALIDATE CONSTRAINT canonical_plan_services_service_slug_fkey;

-- ── Step 4 — write-time concept stamping at the table boundary ──────────────
-- Covers ALL writers (promotion RPC, admin merge remap, future) without
-- touching the 150-line RPC body: INSERT fills a NULL concept_id from the
-- catalog; an UPDATE that CHANGES service_slug re-derives unconditionally
-- (otherwise every future slug remap would strand the OLD slug's concept —
-- the exact staleness this migration is cleaning up).

CREATE OR REPLACE FUNCTION stamp_cps_concept_id()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.concept_id IS NULL THEN
      SELECT sc.concept_id INTO NEW.concept_id
      FROM service_catalog sc WHERE sc.slug = NEW.service_slug;
    END IF;
  ELSIF NEW.service_slug IS DISTINCT FROM OLD.service_slug THEN
    SELECT sc.concept_id INTO NEW.concept_id
    FROM service_catalog sc WHERE sc.slug = NEW.service_slug;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Studio PG14 gotcha: DROP + CREATE, never CREATE OR REPLACE TRIGGER.
DROP TRIGGER IF EXISTS stamp_cps_concept_id ON canonical_plan_services;
CREATE TRIGGER stamp_cps_concept_id
  BEFORE INSERT OR UPDATE OF service_slug ON canonical_plan_services
  FOR EACH ROW EXECUTE FUNCTION stamp_cps_concept_id();

-- Default-privileges hygiene: new functions auto-grant EXECUTE to
-- anon/authenticated; trigger functions never need caller EXECUTE.
REVOKE EXECUTE ON FUNCTION stamp_cps_concept_id() FROM anon, authenticated;

-- =============================================================================
-- VERIFY (run after apply; expectations in brackets):
-- 1) FK present + validated:
--    SELECT conname, convalidated FROM pg_constraint
--    WHERE conname = 'canonical_plan_services_service_slug_fkey';   -- [1 row, t]
-- 2) Trigger present:
--    SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'canonical_plan_services'::regclass
--      AND tgname = 'stamp_cps_concept_id';                          -- [1 row]
-- 3) concept_id coverage:
--    SELECT COUNT(*) FROM canonical_plan_services
--    WHERE concept_id IS NULL;                                       -- [0]
-- 4) Dead-slug leftovers (0 expected; any >0 = virtual cell was occupied,
--    rows intact + FK-valid, log for manual review):
--    SELECT service_slug, COUNT(*) FROM canonical_plan_services
--    WHERE service_slug IN ('telehealth_pcp','telehealth_specialist')
--    GROUP BY 1;                                                     -- [0 rows]
-- 5) Remapped rows landed at virtual — filter on the remap's updated_at
--    fingerprint; the absolute @virtual count ALSO includes ~424 pre-existing
--    regen telehealth rows, so an unfiltered count proves nothing (DEV-apply
--    lesson, 2026-07-27):
--    SELECT service_slug, COUNT(*)
--    FROM canonical_plan_services
--    WHERE place_of_service = 'virtual'
--      AND service_slug IN ('pcp_visit','specialist_visit')
--      AND updated_at > now() - interval '1 hour'
--    GROUP BY 1;                                                     -- [7 total]
-- =============================================================================
