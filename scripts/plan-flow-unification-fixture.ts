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
  bestNumericIndices,
  CATEGORY_DISPLAY_ORDER,
  coveredPerPlanInCategory,
  distinctServiceCount,
  groupBenefitsByCategory,
  sortCategoryGroups,
  variantQualifiedTitle,
  winsPerPlanInCategory,
} from "../src/components/compare/compare-aggregates";
import { pickRepresentativeVariant, type ComparePlanPayload, type CompareBenefit } from "../src/lib/plan/compare";
import {
  applyUsedBenefitsToggle,
  readUsedBenefits,
  USED_BENEFITS_CAP,
} from "../src/lib/plan/benefit-usage";
import { groupCoveredBenefits, isGroupUsed } from "../src/lib/plan/benefit-grouping";
import { formatInNetworkCost, formatOutOfNetworkCost } from "../src/lib/plan/cost-share-format";

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

  // 2. S288 mode/search copy — APPROVED by Andrew S289 (2026-07-27),
  // asserted VERBATIM (the S285 precedent: approved copy is a contract).
  for (const [k, v, expected] of [
    ["OB_COPY.cancel", OB_COPY.cancel, "Cancel"],
    ["OB_COPY.done", OB_COPY.done, "Done"],
    ["OB_COPY.saveChanges", OB_COPY.saveChanges, "Save changes"],
    ["OB_COPY.planModeTitle", OB_COPY.planModeTitle, "Update your plan"],
    [
      "OB_COPY.planModeSub",
      OB_COPY.planModeSub,
      "Replace your plan or insurance card by uploading a document or searching Candid's library.",
    ],
    [
      "OB_CARD_COPY.keptNothing",
      OB_CARD_COPY.keptNothing,
      "Nothing was changed — that card doesn't match the plan on file. Try again.",
    ],
    ["OB_CARD_COPY.currentCardEyebrow", OB_CARD_COPY.currentCardEyebrow, "YOUR CURRENT CARD"],
    ["OB_CARD_COPY.replaceCard", OB_CARD_COPY.replaceCard, "Replace card"],
    [
      "OB_DOC_COPY.searchToggle",
      OB_DOC_COPY.searchToggle,
      "No document handy? Search for your plan instead",
    ],
    [
      "OB_DOC_COPY.searchPlaceholder",
      OB_DOC_COPY.searchPlaceholder,
      "Plan name or insurer — e.g. UHC Gold Advantage",
    ],
    [
      "OB_DOC_COPY.searchHint",
      OB_DOC_COPY.searchHint,
      "Picking your plan from Candid's library fills in your coverage like a document would. You can add the document anytime for verified details.",
    ],
    [
      "OB_DOC_COPY.searchEmpty",
      OB_DOC_COPY.searchEmpty,
      "No matches — try fewer words, or upload a document instead.",
    ],
    ["OB_DOC_COPY.searchSelecting", OB_DOC_COPY.searchSelecting, "Setting up your plan…"],
    [
      "OB_DOC_COPY.searchDone",
      OB_DOC_COPY.searchDone,
      "Plan on file — from Candid's plan library",
    ],
    ["OB_DOC_COPY.searchError", OB_DOC_COPY.searchError, "Couldn't find that plan. Please try again."],
    ["OB_DOC_COPY.searchBack", OB_DOC_COPY.searchBack, "Back to upload"],
    ["OB_DOC_COPY.currentPlanEyebrow", OB_DOC_COPY.currentPlanEyebrow, "YOUR CURRENT PLAN"],
    ["OB_DOC_COPY.replacePlan", OB_DOC_COPY.replacePlan, "Replace plan"],
  ] as const) {
    check(`${k} verbatim`, v, expected);
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

  // ── 6. S289 benefit-usage persistence helpers ───────────────────────────
  {
    check("usage read — null metadata", readUsedBenefits(null).length, 0);
    check("usage read — no key", readUsedBenefits({ other: 1 }).length, 0);
    check("usage read — garbage value", readUsedBenefits({ used_benefits: "nope" }).length, 0);
    const mixed = readUsedBenefits({ used_benefits: ["b", "a", 3, null, "b", ""] });
    check("usage read — filters + dedupes + sorts", JSON.stringify(mixed), '["a","b"]');

    const added = applyUsedBenefitsToggle(null, { add: ["pcp_visit"] });
    check("usage toggle — add to empty", JSON.stringify(added), '["pcp_visit"]');
    const dup = applyUsedBenefitsToggle({ used_benefits: ["pcp_visit"] }, { add: ["pcp_visit"] });
    check("usage toggle — add idempotent", dup.length, 1);
    const removed = applyUsedBenefitsToggle(
      { used_benefits: ["pcp_visit", "generic_rx", "surgery"] },
      { remove: ["generic_rx"] },
    );
    check("usage toggle — remove keeps others", JSON.stringify(removed), '["pcp_visit","surgery"]');
    // Group-off removes every variant form (raw + live) in one call.
    const bothForms = applyUsedBenefitsToggle(
      { used_benefits: ["telehealth_pcp", "pcp_visit", "generic_rx"] },
      { remove: ["telehealth_pcp", "pcp_visit"] },
    );
    check("usage toggle — removes raw+live forms", JSON.stringify(bothForms), '["generic_rx"]');
    const capped = applyUsedBenefitsToggle(
      { used_benefits: Array.from({ length: USED_BENEFITS_CAP + 20 }, (_, i) => `slug_${String(i).padStart(4, "0")}`) },
      { add: ["aaa_first"] },
    );
    check("usage toggle — capped", capped.length, USED_BENEFITS_CAP);
    check("usage toggle — cap keeps sorted head", capped[0], "aaa_first");
  }

  // ── 7. S289 shared benefit-counting rule (dashboard tiles ↔ /plan rows) ──
  {
    const mk = (id: string, title: string, category: string, covered?: boolean | null) => ({
      covered,
      benefit: { id, title, category },
    });
    const groups = groupCoveredBenefits([
      mk("surgery", "Surgery", "surgery"),            // 3 variants, one title →
      mk("surgery", "Surgery", "surgery"),            // ONE group (the tile-vs-plan
      mk("surgery", "Surgery", "surgery"),            // 3-vs-1 mismatch)
      mk("generic_rx", "Generic Drugs", "rx"),
      mk("generic_rx_90day", "Generic Drugs", "rx"),  // same title, 2nd slug
      mk("pcp_visit", "Primary Care Visit", "office_visit"),
      mk("excluded", "Cosmetic Thing", "surgery", false), // covered:false → out
    ]);
    check("grouping — 7 items → 3 covered groups", groups.length, 3);
    const surgery = groups.find((g) => g.title === "Surgery");
    check("grouping — variants dedupe to one slug", surgery?.slugs.length, 1);
    const rx = groups.find((g) => g.title === "Generic Drugs");
    check("grouping — same-title distinct slugs collected", rx?.slugs.length, 2);
    check("grouping — covered:false excluded", groups.some((g) => g.title === "Cosmetic Thing"), false);
    check("grouping — category = first-seen", rx?.category, "rx");
    // One tick = one used group, regardless of how many variants share it.
    const ticked = new Set(["generic_rx"]);
    check("grouping — one tick marks ONE group", groups.filter((g) => isGroupUsed(g, ticked)).length, 1);
    check("grouping — tick on any variant slug counts", isGroupUsed(rx!, new Set(["generic_rx_90day"])), true);
    check("grouping — untucked group not used", isGroupUsed(surgery!, ticked), false);
  }

  // ── 8. S289 cost-share display formatting (the leg-③ blank-cells bug) ────
  // Shapes below are the REAL canonical rows from the E2E screenshot (BCBS TX
  // Silver 605 Surgery/pcp/generic_rx) — the exact cells that rendered "—".
  {
    check(
      "cost fmt — coinsurance decimal + deductible",
      formatInNetworkCost({ in_coinsurance: 0.4, in_deductible_applies: true }),
      "40% coinsurance, after deductible",
    );
    check(
      "cost fmt — plain copay",
      formatInNetworkCost({ in_copay: 115 }),
      "$115 copay",
    );
    check(
      "cost fmt — percent-stored coinsurance normalizes",
      formatInNetworkCost({ in_coinsurance: 50 }),
      "50% coinsurance",
    );
    check("cost fmt — all-null → Covered", formatInNetworkCost({}), "Covered");
    check(
      "cost fmt — zero coinsurance, no copay → No charge",
      formatInNetworkCost({ in_copay: null, in_coinsurance: 0 }),
      "No charge",
    );
    check(
      "cost fmt — OON copay + coinsurance + deductible",
      formatOutOfNetworkCost({ out_copay: 2000, out_coinsurance: 0.5, out_deductible_applies: true }, "HMO"),
      "$2000 copay, 50% coinsurance, after deductible",
    );
    check(
      "cost fmt — OON empty on HMO → Not covered",
      formatOutOfNetworkCost({}, "HMO"),
      "Not covered",
    );
    check(
      "cost fmt — OON empty on PPO → empty (em-dash is honest there)",
      formatOutOfNetworkCost({}, "PPO"),
      "",
    );
    check(
      "cost fmt — OON extracted prose wins",
      formatOutOfNetworkCost({ out_cost_description: "50% after ded.", out_copay: 10 }, "PPO"),
      "50% after ded.",
    );
    // The regression itself: a covered canonical row must NEVER format to "".
    const screenshotRows = [
      { in_coinsurance: 0.4, in_deductible_applies: true },
      { in_coinsurance: 0.5, in_deductible_applies: true },
      { in_copay: 115 },
      { in_copay: 40 },
    ];
    check(
      "cost fmt — no covered row formats to empty (the leg-③ bug)",
      screenshotRows.every((r) => formatInNetworkCost(r).length > 0),
      true,
    );
  }

  // ── 9. S289 Phase B — /compare variant rows (the last-write-wins fix) ────
  {
    const bene = (
      slug: string, title: string, cost: string,
      variant: { pos?: string; component?: string; tier?: string } = {},
    ) => ({
      serviceSlug: slug,
      category: "surgery",
      title,
      placeOfService: variant.pos ?? "any",
      component: variant.component ?? "global",
      planTierLabel: variant.tier ?? "none",
      costInNetworkDescription: cost,
      costOutOfNetworkDescription: "—",
      costSharing: {
        inNetwork: { copay: null, coinsurance: null, deductibleApplies: null },
        outOfNetwork: { copay: null, coinsurance: null, deductibleApplies: null },
        annualLimit: null,
        priorAuthRequired: null,
      },
      covered: true,
      inferred: null,
    });
    // Plan A: 3 surgery variants (the e4e shape). Plan B: only the facility one.
    const planA = {
      benefits: [
        bene("surgery", "Surgery", "40% coinsurance, after deductible", { pos: "independent_facility", component: "facility" }),
        bene("surgery", "Surgery", "50% coinsurance, after deductible", { component: "professional" }),
        bene("surgery", "Surgery", "50% coinsurance, after deductible"),
      ],
    } as unknown as ComparePlanPayload;
    const planB = {
      benefits: [bene("surgery", "Surgery", "30% coinsurance", { pos: "independent_facility", component: "facility" })],
    } as unknown as ComparePlanPayload;

    const groups = groupBenefitsByCategory([planA, planB]);
    const rows = groups.find((g) => g.category === "surgery")?.rows ?? [];
    check("compare variants — ALL 3 variants get rows (was last-wins 1)", rows.length, 3);
    const facility = rows.find((r) => r.variantKey.includes("|facility|"));
    check(
      "compare variants — Andrew title scheme (fees + place)",
      facility?.title,
      "Surgery Facility Fees — independent facility",
    );
    check("compare variants — plan B fills its variant cell", facility?.perPlan[1]?.costInNetworkDescription, "30% coinsurance");
    const professional = rows.find((r) => r.variantKey.includes("|professional|"));
    check("compare variants — professional fees title, no place tail", professional?.title, "Surgery Professional Fees");
    check("compare variants — plan B lacks professional → null cell", professional?.perPlan[1], null);
    check(
      "compare variants — correct cost per variant (A facility = 40%)",
      facility?.perPlan[0]?.costInNetworkDescription,
      "40% coinsurance, after deductible",
    );
    // Determinism: shuffled input order yields identical row order.
    const shuffled = {
      benefits: [planA.benefits[2], planA.benefits[0], planA.benefits[1]],
    } as unknown as ComparePlanPayload;
    const rows2 = groupBenefitsByCategory([shuffled, planB]).find((g) => g.category === "surgery")?.rows ?? [];
    check(
      "compare variants — row order independent of input order",
      JSON.stringify(rows2.map((r) => r.variantKey)),
      JSON.stringify(rows.map((r) => r.variantKey)),
    );
    // Single-variant slug stays unqualified.
    const lone = groupBenefitsByCategory([
      { benefits: [bene("pcp_visit", "Primary Care Visit", "$20 copay")] } as unknown as ComparePlanPayload,
    ]);
    check("compare variants — single variant keeps clean title", lone[0]?.rows[0]?.title, "Primary Care Visit");
    // Title scheme details (Andrew S289): pre-dash = charge kind (fees/tier),
    // post-dash = place. Tier is a BUCKET, so it joins the pre-dash slot.
    check(
      "compare variants — tier is pre-dash, Title Case (bucket, not place)",
      variantQualifiedTitle("Generic Drugs", bene("generic_rx", "Generic Drugs", "", { pos: "retail_pharmacy", tier: "tier_1" }) as unknown as CompareBenefit),
      "Generic Drugs Tier 1 — retail pharmacy",
    );
    check(
      "compare variants — PCP office casing",
      variantQualifiedTitle("Office Visit", bene("pcp_visit", "Office Visit", "", { pos: "pcp_office" }) as unknown as CompareBenefit),
      "Office Visit — PCP office",
    );

    // ── Review F1: no "best" without competition ──
    check("review F1 — single populated value wins nothing", JSON.stringify(bestNumericIndices([10, null], (v) => v as number | null, true)), "[]");
    check("review F1 — two values still rank", JSON.stringify(bestNumericIndices([10, 20], (v) => v as number | null, true)), "[0]");

    // ── Review F2/F6: slug-level counts ──
    check("review F6 — header counts services not variants", distinctServiceCount(rows), 1);
    const covered = coveredPerPlanInCategory(rows, 2);
    check("review F2 — covered counts slugs (A: 1 not 3)", covered[0], 1);
    check("review F2 — covered counts slugs (B: 1)", covered[1], 1);
    const withCopay = (slug: string, variant: { pos?: string; component?: string; tier?: string }, copay: number) => ({
      ...(bene(slug, "Surgery", "", variant) as object),
      costSharing: { inNetwork: { copay, coinsurance: null, deductibleApplies: null }, outOfNetwork: { copay: null, coinsurance: null, deductibleApplies: null }, annualLimit: null, priorAuthRequired: null },
    });
    const winRowsOf = (aBenefits: object[], bBenefits: object[]) =>
      groupBenefitsByCategory([
        { benefits: aBenefits } as unknown as ComparePlanPayload,
        { benefits: bBenefits } as unknown as ComparePlanPayload,
      ]).find((g) => g.category === "surgery")?.rows ?? [];

    // Andrew's model: a service counts ONCE, decided by row-majority among
    // contested rows. A wins 3 of 4 shared variants → one win, not three.
    const majority = winsPerPlanInCategory(
      winRowsOf(
        [
          withCopay("surgery", { component: "facility", pos: "independent_facility" }, 100),
          withCopay("surgery", { component: "facility", pos: "outpatient_facility" }, 100),
          withCopay("surgery", { component: "professional" }, 100),
          withCopay("surgery", {}, 500),
        ],
        [
          withCopay("surgery", { component: "facility", pos: "independent_facility" }, 200),
          withCopay("surgery", { component: "facility", pos: "outpatient_facility" }, 200),
          withCopay("surgery", { component: "professional" }, 200),
          withCopay("surgery", {}, 300),
        ],
      ),
      2,
    );
    check("wins — 3-of-4 row majority = ONE slug win", JSON.stringify(majority), "[1,0]");
    // 1-1 contested split → nobody claims the service.
    const tie = winsPerPlanInCategory(
      winRowsOf(
        [withCopay("surgery", { component: "facility" }, 100), withCopay("surgery", { component: "professional" }, 500)],
        [withCopay("surgery", { component: "facility" }, 200), withCopay("surgery", { component: "professional" }, 300)],
      ),
      2,
    );
    check("wins — row-win tie → no winner", JSON.stringify(tie), "[0,0]");
    // Disjoint variant sets → zero contested rows → no apples-to-oranges win.
    const disjoint = winsPerPlanInCategory(
      winRowsOf(
        [withCopay("surgery", { component: "facility" }, 100)],
        [withCopay("surgery", { component: "professional" }, 999)],
      ),
      2,
    );
    check("wins — disjoint variants → no winner", JSON.stringify(disjoint), "[0,0]");
    // Single shared row still decides.
    const single = winsPerPlanInCategory(
      winRowsOf(
        [withCopay("surgery", { component: "facility" }, 100)],
        [withCopay("surgery", { component: "facility" }, 200)],
      ),
      2,
    );
    check("wins — single contested row decides", JSON.stringify(single), "[1,0]");

    // ── Review F5: representative variant ──
    const repDefault = pickRepresentativeVariant([
      bene("surgery", "Surgery", "", { component: "facility" }) as unknown as CompareBenefit,
      bene("surgery", "Surgery", "") as unknown as CompareBenefit,
    ]);
    check("review F5 — default variant preferred", (repDefault as { component?: string })?.component, "global");
    const repSorted = pickRepresentativeVariant([
      bene("surgery", "Surgery", "", { component: "professional" }) as unknown as CompareBenefit,
      bene("surgery", "Surgery", "", { component: "facility" }) as unknown as CompareBenefit,
    ]);
    check("review F5 — else lowest variant key (facility < professional)", (repSorted as { component?: string })?.component, "facility");

    // ── Kill switch: per-slug rows, representative cells, clean titles ──
    const legacy = groupBenefitsByCategory([planA, planB], { variantRows: false });
    const legacyRows = legacy.find((g) => g.category === "surgery")?.rows ?? [];
    check("kill switch — one row per slug", legacyRows.length, 1);
    check("kill switch — clean title", legacyRows[0]?.title, "Surgery");
    check(
      "kill switch — cell holds the DEFAULT variant (not last-write)",
      legacyRows[0]?.perPlan[0]?.costInNetworkDescription,
      "50% coinsurance, after deductible",
    );
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
})();
