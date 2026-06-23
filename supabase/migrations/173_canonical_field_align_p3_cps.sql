-- Migration 173: Canonical Field-Name Alignment — Phase 3 (canonical_plan_services) — FREEZE legacy
-- F.0 per plans/canonical_field_alignment.md §4 Phase 3 (S212, 2026-06-23). ADDITIVE + REVERSIBLE.
--
-- WHY
--   Phase 2 (mig 169) made the aligned columns (in_copay / in_coinsurance / in_deductible_applies /
--   covered / prior_auth_required) authoritative and installed a SYMMETRIC legacy<->aligned mirror.
--   Phase 3 FREEZES the legacy columns so Phase 4 can DROP them. Every known writer now writes the
--   ALIGNED columns: apply_promotion_event (mig 169), canonical-match.ts, corrections/route.ts, AND
--   the cold-start importer wire-plan-catalog-to-canonical.ts (flipped in this same PR). GATE-1
--   re-proved ZERO in-repo readers of the legacy names.
--
-- WHAT (Phase 3 of 5; canonical_plan_services ONLY — canonical_plans is Phase 5)
--   1. align_mirror_cps_row(): downgrade the SYMMETRIC mirror to a DORMANT one-directional
--      legacy -> aligned safety net.
--        * The aligned -> legacy direction is REMOVED — aligned writes no longer touch the
--          deprecated legacy columns, so legacy FREEZES (ready for the Phase-4 DROP).
--        * The legacy -> aligned direction is RETAINED but now only fires if some unknown /
--          out-of-repo writer still sets a legacy column, keeping the authoritative aligned twin
--          from silently missing that write.
--        * Guarded by IS DISTINCT FROM OLD (typed cols AND provenance keys) so a STALE legacy
--          value/key on the 48,552 backfilled rows can never clobber a fresh aligned write.
--      Function-body replace ONLY (CREATE OR REPLACE FUNCTION) — the trigger
--      canonical_plan_services_align_dualwrite already calls it, binding UNCHANGED -> NO trigger DDL
--      (and therefore no exposure to the PG14 `CREATE OR REPLACE TRIGGER` silent-abort, the mig-169
--      lesson). The trigger name still says "dualwrite"; it is now one-directional — left as-is to
--      avoid trigger DDL (cosmetic; behavior documented here + in the column comments).
--   2. COMMENT ON COLUMN the 5 legacy columns as DEPRECATED/FROZEN, each pointing at its aligned
--      twin + the Phase-4 DROP. Documentation only; metadata.
--
-- NOT IN THIS MIGRATION (Phase-4 pre-DROP sweep — net-protected meanwhile):
--   - flip scripts/admin/rc-3-path-b-backfill.ts CPS_FIELDS (dormant, manually-run one-shot)
--   - remove the dead legacy per-service candidate names in src/lib/plan/process-plan.ts (0-fire no-ops)
--   - DROP the 5 legacy columns + provenance keys + remove this dormant net (mig 174; post-soak + sign-off)
--
-- FIRE-ORDER (unchanged): canonical_plan_services_align_dualwrite ('align' < 'confidence') still
--   fires BEFORE canonical_plan_services_confidence_recompute (mig 056). The net only ADDS aligned
--   keys from legacy ones (identical confidence), so MIN(non-'_'-prefixed keys) is unchanged.
--
-- ROLLBACK (reversible — legacy columns + keys still populated/frozen; aligned authoritative):
--   Re-apply mig 169's align_mirror_cps_row() (the SYMMETRIC body) to restore aligned<->legacy
--   dual-write, and revert the importer rename (same PR). No data loss at any point.

BEGIN;

-- ── 1. Downgrade the mirror to a DORMANT one-directional legacy -> aligned safety net ──
CREATE OR REPLACE FUNCTION align_mirror_cps_row()
RETURNS TRIGGER AS $$
BEGIN
  -- F.0 Phase 3 (mig 173): legacy is FROZEN. Only back-fill the aligned twin FROM legacy, and only
  -- when a legacy column was actually set/changed (dormant net for an unknown legacy writer).
  IF TG_OP = 'INSERT' THEN
    IF NEW.in_copay              IS NULL THEN NEW.in_copay              := NEW.copay;               END IF;
    IF NEW.in_coinsurance        IS NULL THEN NEW.in_coinsurance        := NEW.coinsurance;         END IF;
    IF NEW.in_deductible_applies IS NULL THEN NEW.in_deductible_applies := NEW.deductible_applies;  END IF;
    IF NEW.covered               IS NULL THEN NEW.covered               := NEW.is_covered;          END IF;
    IF NEW.prior_auth_required   IS NULL THEN NEW.prior_auth_required   := NEW.requires_prior_auth; END IF;
  ELSE  -- UPDATE: propagate legacy -> aligned ONLY when the legacy side actually changed
    IF NEW.copay               IS DISTINCT FROM OLD.copay               THEN NEW.in_copay              := NEW.copay;               END IF;
    IF NEW.coinsurance         IS DISTINCT FROM OLD.coinsurance         THEN NEW.in_coinsurance        := NEW.coinsurance;         END IF;
    IF NEW.deductible_applies  IS DISTINCT FROM OLD.deductible_applies  THEN NEW.in_deductible_applies := NEW.deductible_applies;  END IF;
    IF NEW.is_covered          IS DISTINCT FROM OLD.is_covered          THEN NEW.covered               := NEW.is_covered;          END IF;
    IF NEW.requires_prior_auth IS DISTINCT FROM OLD.requires_prior_auth THEN NEW.prior_auth_required   := NEW.requires_prior_auth; END IF;
  END IF;

  -- Provenance: legacy -> aligned only, same guard. out_* already match the convention -> untouched.
  -- Legacy keys are PRESERVED (frozen) through the Phase-3 window.
  IF NEW.field_provenance IS NOT NULL AND NEW.field_provenance <> '{}'::jsonb THEN
    IF TG_OP = 'INSERT' THEN
      IF (NEW.field_provenance ? 'copay')               AND NOT (NEW.field_provenance ? 'in_copay')              THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_copay',              NEW.field_provenance->'copay');               END IF;
      IF (NEW.field_provenance ? 'coinsurance')         AND NOT (NEW.field_provenance ? 'in_coinsurance')        THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_coinsurance',        NEW.field_provenance->'coinsurance');         END IF;
      IF (NEW.field_provenance ? 'deductible_applies')  AND NOT (NEW.field_provenance ? 'in_deductible_applies') THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_deductible_applies', NEW.field_provenance->'deductible_applies');  END IF;
      IF (NEW.field_provenance ? 'is_covered')          AND NOT (NEW.field_provenance ? 'covered')              THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('covered',               NEW.field_provenance->'is_covered');          END IF;
      IF (NEW.field_provenance ? 'requires_prior_auth') AND NOT (NEW.field_provenance ? 'prior_auth_required')  THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('prior_auth_required',   NEW.field_provenance->'requires_prior_auth'); END IF;
    ELSE  -- UPDATE: only when the legacy provenance key actually changed (avoid stale-legacy clobber)
      IF NEW.field_provenance->'copay'               IS DISTINCT FROM OLD.field_provenance->'copay'               AND (NEW.field_provenance ? 'copay')               THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_copay',              NEW.field_provenance->'copay');               END IF;
      IF NEW.field_provenance->'coinsurance'         IS DISTINCT FROM OLD.field_provenance->'coinsurance'         AND (NEW.field_provenance ? 'coinsurance')         THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_coinsurance',        NEW.field_provenance->'coinsurance');         END IF;
      IF NEW.field_provenance->'deductible_applies'  IS DISTINCT FROM OLD.field_provenance->'deductible_applies'  AND (NEW.field_provenance ? 'deductible_applies')  THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('in_deductible_applies', NEW.field_provenance->'deductible_applies');  END IF;
      IF NEW.field_provenance->'is_covered'          IS DISTINCT FROM OLD.field_provenance->'is_covered'          AND (NEW.field_provenance ? 'is_covered')          THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('covered',               NEW.field_provenance->'is_covered');          END IF;
      IF NEW.field_provenance->'requires_prior_auth' IS DISTINCT FROM OLD.field_provenance->'requires_prior_auth' AND (NEW.field_provenance ? 'requires_prior_auth') THEN NEW.field_provenance := NEW.field_provenance || jsonb_build_object('prior_auth_required',   NEW.field_provenance->'requires_prior_auth'); END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 2. Deprecate the 5 legacy columns (documentation/metadata only) ──
COMMENT ON COLUMN canonical_plan_services.copay IS
  'DEPRECATED (F.0 Phase 3, mig 173): FROZEN. Authoritative twin = in_copay. No writer maintains this as of Phase 3; the dormant align_mirror_cps_row net only back-fills in_copay if an unknown writer still sets this. DROP in Phase 4 (post-soak + sign-off).';
COMMENT ON COLUMN canonical_plan_services.coinsurance IS
  'DEPRECATED (F.0 Phase 3, mig 173): FROZEN. Authoritative twin = in_coinsurance. DROP in Phase 4 (post-soak + sign-off).';
COMMENT ON COLUMN canonical_plan_services.deductible_applies IS
  'DEPRECATED (F.0 Phase 3, mig 173): FROZEN. Authoritative twin = in_deductible_applies. DROP in Phase 4 (post-soak + sign-off).';
COMMENT ON COLUMN canonical_plan_services.is_covered IS
  'DEPRECATED (F.0 Phase 3, mig 173): FROZEN. Authoritative twin = covered. DROP in Phase 4 (post-soak + sign-off).';
COMMENT ON COLUMN canonical_plan_services.requires_prior_auth IS
  'DEPRECATED (F.0 Phase 3, mig 173): FROZEN. Authoritative twin = prior_auth_required. DROP in Phase 4 (post-soak + sign-off).';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- VERIFY (read-only; run AFTER apply — Studio can falsely report success on a partial run):
--   1) aligned->legacy direction GONE (expect f):
-- SELECT pg_get_functiondef('align_mirror_cps_row()'::regprocedure) ILIKE '%:= new.in_copay%' AS still_writes_legacy;
--   2) dormant legacy->aligned net PRESENT (expect t):
-- SELECT pg_get_functiondef('align_mirror_cps_row()'::regprocedure) ILIKE '%new.in_copay := new.copay%' AS net_present;
--   3) 5 deprecation comments present (expect 5):
-- SELECT count(*) FROM pg_description d
--   JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
--   WHERE d.objoid = 'canonical_plan_services'::regclass AND d.description LIKE 'DEPRECATED (F.0 Phase 3%';
--   4) trigger unchanged + still fires before confidence recompute (expect align_dualwrite before confidence_recompute):
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'canonical_plan_services'::regclass AND NOT tgisinternal ORDER BY tgname;
-- ─────────────────────────────────────────────────────────────────────────────────────────────
