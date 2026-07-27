#!/usr/bin/env tsx
/**
 * Plan-flow unification fixture (S288; manually re-runnable).
 *
 * Covers the pure/serverside seams of the arc:
 *   1. loadPlanCostShareParams canonical fallback (mocked Supabase):
 *      - user-row terms present → user values win, canonical never consulted
 *      - user-row terms null + canonical link → canonical fills the gaps
 *      - PARTIAL user terms → only the null fields fall back
 *      - no canonical link → nulls stay null (old behavior)
 *      - canonical read throws → fail-open to user-row values
 *   2. The S288 copy keys exist and are non-empty (OB_COPY mode strings +
 *      OB_DOC_COPY search strings) — the flow renders them unconditionally in
 *      their modes, so a missing key is a blank button.
 *
 * NOT tested here (needs DB/browser — the DEV E2E legs): set-active
 * persistence, the onboarding mode routing, entry-point re-points.
 *
 * Run: npx tsx scripts/plan-flow-unification-fixture.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPlanCostShareParams } from "../src/lib/claims/cost-share-loader";
import { OB_CARD_COPY, OB_COPY, OB_DOC_COPY } from "../src/lib/onboarding/simplified";
import { loadCatalogIdentity } from "../src/lib/plan/catalog-identity";
import {
  SERVICE_CATEGORY_LABELS,
  labelForCategory,
  categoryToDomain,
} from "../src/lib/plan/category-display";
import {
  CATEGORY_DISPLAY_ORDER,
  sortCategoryGroups,
} from "../src/components/compare/compare-aggregates";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(
      `  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Minimal chainable Supabase mock: per-table maybeSingle payloads. */
function mockSupabase(rows: {
  insurance_plans?: Record<string, unknown> | null;
  canonical_plans?: Record<string, unknown> | null;
  canonicalThrows?: boolean;
}): SupabaseClient {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    const ret = () => self;
    self.select = ret;
    self.eq = ret;
    self.order = ret;
    self.limit = ret;
    self.maybeSingle = async () => {
      if (table === "canonical_plans" && rows.canonicalThrows) throw new Error("boom");
      const data = table === "insurance_plans" ? rows.insurance_plans : rows.canonical_plans;
      return { data: data ?? null, error: null };
    };
    return self;
  };
  return { from: (t: string) => chain(t) } as unknown as SupabaseClient;
}

// REAL canonical_plans column names (legacy in-network names + out_-prefixed
// OON, mig 192) — the loader must MAP these onto the in_* param shape; keying
// this mock with in_* names would hide a column-name regression (the exact
// silent 42703 the S288 E2E surfaced).
const CANON_TERMS = {
  deductible_individual: 1500,
  deductible_family: 3000,
  oop_max_individual: 6000,
  oop_max_family: 12000,
  out_deductible_individual: 4000,
  out_deductible_family: 8000,
  out_oop_max_individual: 15000,
  out_oop_max_family: 30000,
};

(async () => {
  console.log("plan-flow-unification fixture");

  // 1a. User terms present → user wins (canonical would say 1500; user says 500).
  {
    const p = await loadPlanCostShareParams(
      mockSupabase({
        insurance_plans: {
          canonical_plan_id: "c1",
          in_deductible_individual: 500,
          in_deductible_family: 1000,
          out_deductible_individual: 2000,
          out_deductible_family: 4000,
          in_oop_max_individual: 3000,
          in_oop_max_family: 6000,
          out_oop_max_individual: 9000,
          out_oop_max_family: 18000,
        },
        canonical_plans: CANON_TERMS,
      }),
      "plan-1",
    );
    check("user terms win — in ded", p?.inDeductibleIndividual, 500);
    check("user terms win — out OOP fam", p?.outOopMaxFamily, 18000);
  }

  // 1b. Link-only catalog_match row (all terms null) → canonical fills.
  {
    const p = await loadPlanCostShareParams(
      mockSupabase({
        insurance_plans: { canonical_plan_id: "c1" },
        canonical_plans: CANON_TERMS,
      }),
      "plan-1",
    );
    check("fallback — in ded ind", p?.inDeductibleIndividual, 1500);
    check("fallback — in OOP ind", p?.inOopMaxIndividual, 6000);
    check("fallback — out ded fam", p?.outDeductibleFamily, 8000);
    check("fallback — out OOP fam", p?.outOopMaxFamily, 30000);
  }

  // 1c. Partial user terms → only nulls fall back.
  {
    const p = await loadPlanCostShareParams(
      mockSupabase({
        insurance_plans: { canonical_plan_id: "c1", in_deductible_individual: 750 },
        canonical_plans: CANON_TERMS,
      }),
      "plan-1",
    );
    check("partial — user in ded kept", p?.inDeductibleIndividual, 750);
    check("partial — null in OOP filled", p?.inOopMaxIndividual, 6000);
  }

  // 1d. No canonical link → nulls stay null (pre-S288 behavior).
  {
    const p = await loadPlanCostShareParams(
      mockSupabase({ insurance_plans: {}, canonical_plans: CANON_TERMS }),
      "plan-1",
    );
    check("no link — stays null", p?.inDeductibleIndividual, null);
  }

  // 1e. Canonical read throws → fail-open to the user row.
  {
    const p = await loadPlanCostShareParams(
      mockSupabase({
        insurance_plans: { canonical_plan_id: "c1", in_oop_max_family: 7000 },
        canonicalThrows: true,
      }),
      "plan-1",
    );
    check("fail-open — user value survives", p?.inOopMaxFamily, 7000);
    check("fail-open — unfilled stays null", p?.inDeductibleIndividual, null);
  }

  // 2. S288 copy keys present + non-empty.
  for (const [k, v] of [
    ["OB_COPY.cancel", OB_COPY.cancel],
    ["OB_COPY.done", OB_COPY.done],
    ["OB_COPY.saveChanges", OB_COPY.saveChanges],
    ["OB_DOC_COPY.searchToggle", OB_DOC_COPY.searchToggle],
    ["OB_DOC_COPY.searchPlaceholder", OB_DOC_COPY.searchPlaceholder],
    ["OB_DOC_COPY.searchHint", OB_DOC_COPY.searchHint],
    ["OB_DOC_COPY.searchEmpty", OB_DOC_COPY.searchEmpty],
    ["OB_DOC_COPY.searchSelecting", OB_DOC_COPY.searchSelecting],
    ["OB_DOC_COPY.searchDone", OB_DOC_COPY.searchDone],
    ["OB_DOC_COPY.searchError", OB_DOC_COPY.searchError],
    ["OB_DOC_COPY.searchBack", OB_DOC_COPY.searchBack],
    ["OB_DOC_COPY.currentPlanEyebrow", OB_DOC_COPY.currentPlanEyebrow],
    ["OB_DOC_COPY.replacePlan", OB_DOC_COPY.replacePlan],
    ["OB_CARD_COPY.keptNothing", OB_CARD_COPY.keptNothing],
    ["OB_CARD_COPY.currentCardEyebrow", OB_CARD_COPY.currentCardEyebrow],
    ["OB_CARD_COPY.replaceCard", OB_CARD_COPY.replaceCard],
    ["OB_COPY.planModeTitle", OB_COPY.planModeTitle],
    ["OB_COPY.planModeSub", OB_COPY.planModeSub],
  ] as const) {
    check(`${k} non-empty`, typeof v === "string" && v.length > 0, true);
  }

  // ── 3. S289 catalog-identity resolver (mocked service_catalog) ──────────
  // Mock supports .in("slug", …) and .in("id", …) against a fixed catalog:
  //   pcp_visit (live, office_visit) ← telehealth_pcp (merged, dead)
  //   generic_rx (live, rx)
  {
    const CATALOG = [
      { id: "id-pcp", slug: "pcp_visit", name: "Primary Care Visit", category: "office_visit", merged_into_id: null, concept_id: "con-pcp" },
      { id: "id-tele", slug: "telehealth_pcp", name: "Telehealth — Primary Care", category: "office_visit", merged_into_id: "id-pcp", concept_id: "con-tele" },
      { id: "id-rx", slug: "generic_rx", name: "Generic Drugs", category: "rx", merged_into_id: null, concept_id: "con-rx" },
    ];
    let queries = 0;
    const catalogMock = {
      from: (table: string) => ({
        select: () => ({
          in: async (col: string, vals: string[]) => {
            queries++;
            if (table !== "service_catalog") return { data: [], error: null };
            const key = col === "slug" ? "slug" : "id";
            return { data: CATALOG.filter((r) => vals.includes(r[key as "slug" | "id"])), error: null };
          },
        }),
      }),
    } as unknown as SupabaseClient;

    const m = await loadCatalogIdentity(catalogMock, [
      "pcp_visit", "telehealth_pcp", "generic_rx", "pcp_visit", null, "unknown_slug",
    ]);
    check("resolver — live slug identity", m.get("pcp_visit")?.liveSlug, "pcp_visit");
    check("resolver — live name", m.get("pcp_visit")?.name, "Primary Care Visit");
    check("resolver — merged slug follows chain", m.get("telehealth_pcp")?.liveSlug, "pcp_visit");
    check("resolver — merged slug live category", m.get("telehealth_pcp")?.category, "office_visit");
    check("resolver — merged slug live concept", m.get("telehealth_pcp")?.conceptId, "con-pcp");
    check("resolver — live rx category", m.get("generic_rx")?.category, "rx");
    check("resolver — unknown slug absent", m.has("unknown_slug"), false);
    check("resolver — dedupe (5 in, 3 distinct known)", m.size, 3);
    check("resolver — no target refetch when chain in hand", queries, 1);

    const empty = await loadCatalogIdentity(catalogMock, [null, undefined]);
    check("resolver — empty input skips query", empty.size, 0);
  }

  // ── 4. S289 display maps ────────────────────────────────────────────────
  {
    // Every mig-148 CHECK category has an explicit label (no titleCase fallthrough).
    const V1 = ["office_visit","emergency","hospital","imaging","lab","rx","therapy","mental_health","maternity","dme","preventive","other","long_term_care","dental","vision","surgery","hospitalization","dialysis","family_planning"];
    check("labels — all 19 V1 categories labeled", V1.every((c) => Boolean(SERVICE_CATEGORY_LABELS[c])), true);
    // V1-first precedence: maternity is "Maternity" (not V2's broader label)…
    check("labels — maternity V1-first", labelForCategory("maternity"), "Maternity");
    check("labels — maternity V1-first (db source)", labelForCategory("maternity", "user_plan_with_canonical"), "Maternity");
    // …except the static_catalog path, whose V2 bucket genuinely includes family planning.
    check("labels — maternity V2 on static_catalog", labelForCategory("maternity", "static_catalog"), "Maternity & Family Planning");
    // V2-only keys still resolve on every path.
    check("labels — V2-only key resolves", labelForCategory("preventive_care"), "Preventive Care");
    check("labels — unknown auto title-case", labelForCategory("some_new_thing"), "Some New Thing");
    // categoryToDomain: the 7 previously-missing keys land on real tiles.
    check("domain — long_term_care→ltc", categoryToDomain("long_term_care"), "ltc");
    check("domain — hospitalization→hospital", categoryToDomain("hospitalization"), "hospital");
    check("domain — surgery→hospital", categoryToDomain("surgery"), "hospital");
    check("domain — dialysis→ltc", categoryToDomain("dialysis"), "ltc");
    check("domain — family_planning→maternity", categoryToDomain("family_planning"), "maternity");
    check("domain — dental→other (no tile)", categoryToDomain("dental"), "other");
    check("domain — unknown→other", categoryToDomain("never_heard_of_it"), "other");
  }

  // ── 5. S289 /compare display order — keys are REAL V1 categories ────────
  {
    const v1Check = new Set(["office_visit","emergency","hospital","imaging","lab","rx","therapy","mental_health","maternity","dme","preventive","other","long_term_care","dental","vision","surgery","hospitalization","dialysis","family_planning"]);
    check(
      "compare order — every key is a real category",
      CATEGORY_DISPLAY_ORDER.every((c) => v1Check.has(c.slug)),
      true,
    );
    const sorted = sortCategoryGroups([
      { category: "other", rows: [] },
      { category: "rx", rows: [] },
      { category: "office_visit", rows: [] },
      { category: "dme", rows: [] },
      { category: "long_term_care", rows: [] },
    ]);
    check("compare order — office_visit first of these", sorted[0].category, "office_visit");
    check("compare order — office_visit labeled", sorted[0].label, "Office visits");
    check("compare order — rx labeled Prescriptions", sorted.find((g) => g.category === "rx")?.label, "Prescriptions");
    check("compare order — dme labeled Equipment", sorted.find((g) => g.category === "dme")?.label, "Equipment & supplies");
    check("compare order — other sorts LAST", sorted[sorted.length - 1].category, "other");
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
})();
