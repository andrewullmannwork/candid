/* S292 fixture — insurer FAMILY test + stub-assembly policy (Andrew E2E,
 * andrew29 "Blue Cross" incident).
 * Runnable: npx tsx scripts/s292-insurer-family-fixture.ts
 * Hermetic: pure functions only — no network, no DB, no env.
 *
 * THE INCIDENT (DEV, 2026-07-29, user andrew29@candidclaim.com): a card scan
 * created a stub plan (source=manual, insurer_name="Blue Cross", plan_name
 * null). The SBC upload parsed "Blue Cross Blue Shield of Wyoming". Both
 * names resolved in insurer_catalog — which carries one row per LEGAL ENTITY,
 * ~30 Blue-Cross-family rows — to DIFFERENT ids, because resolving a bare
 * brand name against a family of entities is order-dependent luck
 * (matchInsurerCatalog returns the first substring hit). Rule 4 then asserted
 * a carrier change ("This document is from Blue Cross Blue Shield of Wyoming,
 * not Blue Cross.") and the user was asked to pick between her own card and
 * her own SBC during onboarding.
 *
 * Two fixes under test:
 *   1. Rule-4 family guard — differing catalog ids may assert `insurer_differs`
 *      only when the NAMES don't family-match (the same normalized-containment
 *      test set-active-canonical.ts has used since S288, now shared in
 *      insurer-match.ts). Rule 5 (`canonical_differs`) is deliberately NOT
 *      guarded: two proven catalog links are two policies whatever the names
 *      say.
 *   2. Stub-assembly call-site policy (`shouldAssembleStub`) — card stub +
 *      same-family document is ASSEMBLY (merge, receipt, no prompt), never a
 *      "pick one" question.
 */
import {
  resolvePlanIdentity,
  shouldAssembleStub,
  STUB_ASSEMBLY_REASON,
  type PlanIdentityFacts,
} from "@/lib/plan/plan-identity";
import {
  insurerNamesSameFamily,
  decideCardPreservation,
} from "@/lib/plan/insurer-match";
import type { SupabaseClient } from "@supabase/supabase-js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const f = (o: PlanIdentityFacts): PlanIdentityFacts => o;

// A supabase client that EXPLODES on any touch — proves the paths under test
// are genuinely DB-free. If decideCardPreservation's fast paths ever start
// querying, this fixture goes red instead of quietly hitting a database.
const explodingSupabase = new Proxy(
  {},
  {
    get() {
      throw new Error("hermetic fixture touched the database");
    },
  },
) as unknown as SupabaseClient;

/* ── 1. Family test unit rows ──────────────────────────────────────────────── */

check(
  "family: 'Blue Cross' ~ 'Blue Cross Blue Shield of Wyoming'",
  insurerNamesSameFamily("Blue Cross", "Blue Cross Blue Shield of Wyoming"),
);
check(
  "family: 'Blue Cross' ~ 'CareFirst BlueCross BlueShield' (punctuation-blind)",
  insurerNamesSameFamily("Blue Cross", "CareFirst BlueCross BlueShield"),
);
check("family: 'Cigna' !~ 'Aetna'", !insurerNamesSameFamily("Cigna", "Aetna"));
check(
  "family: blank side is NOT agreement",
  !insurerNamesSameFamily("", "Blue Cross") && !insurerNamesSameFamily(null, "Blue Cross"),
);
check(
  "family: abbreviations are the catalog's job, not containment's ('UHC' !~ 'UnitedHealthcare Insurance Company')",
  !insurerNamesSameFamily("UHC", "UnitedHealthcare Insurance Company"),
);

/* ── 2. Rule-4 family guard — "Blue Cross" vs real BCBS entities ───────────
 * Entity names below are REAL insurer_catalog rows from DEV (2026-07-29).
 * Each resolves to its own catalog id; the ids therefore DIFFER from whatever
 * id the bare "Blue Cross" luck-resolved to. Post-guard: none of these may
 * assert insurer_differs; with no stronger facts they land on uncertain. */

const BCBS_ENTITIES = [
  "Blue Cross Blue Shield of Wyoming",
  "Anthem Blue Cross",
  "Blue Cross and Blue Shield of Texas",
  "CareFirst BlueCross BlueShield",
  "Blue Cross Blue Shield of Massachusetts",
];
for (const entity of BCBS_ENTITIES) {
  const r = resolvePlanIdentity(
    f({ insurerCatalogId: "cat-luck-of-the-draw", insurerName: "Blue Cross", planName: null }),
    f({ insurerCatalogId: `cat-${entity}`, insurerName: entity, planName: "Some Plan" }),
  );
  check(
    `rule 4 guard: 'Blue Cross' vs '${entity}' (ids differ) → NOT insurer_differs`,
    r.reason !== "insurer_differs",
    `${r.verdict}/${r.reason}`,
  );
}

// Names absent on one side → ids keep the verdict (no evidence is not agreement).
const noNames = resolvePlanIdentity(
  f({ insurerCatalogId: "cat-a", insurerName: null }),
  f({ insurerCatalogId: "cat-b", insurerName: "Blue Cross Blue Shield of Wyoming" }),
);
check(
  "rule 4 guard: nameless side keeps the id verdict → insurer_differs",
  noNames.verdict === "different" && noNames.reason === "insurer_differs",
  `${noNames.verdict}/${noNames.reason}`,
);

/* ── 3. Genuinely different carriers still differ ─────────────────────────── */

const cignaAetna = resolvePlanIdentity(
  f({ insurerCatalogId: "cat-cigna", insurerName: "Cigna", planName: "Open Access Plus" }),
  f({ insurerCatalogId: "cat-aetna", insurerName: "Aetna", planName: "Managed Choice" }),
);
check(
  "Cigna vs Aetna (ids differ, no family) → still insurer_differs",
  cignaAetna.verdict === "different" && cignaAetna.reason === "insurer_differs",
  `${cignaAetna.verdict}/${cignaAetna.reason}`,
);

/* ── 4. CRITICAL — the guard is rule 4's ONLY. Same-family names with two
 * PROVEN catalog links (both ≥ floor, different ids) are two policies:
 * rule 5 must still fire. ─────────────────────────────────────────────────── */

const sameFamilyDiffCanonical = resolvePlanIdentity(
  f({
    canonicalPlanId: "canon-aaaa",
    canonicalConfidence: 0.95,
    insurerCatalogId: "cat-bc-1",
    insurerName: "Blue Cross",
    planName: "BlueSelect Bronze Basic",
  }),
  f({
    canonicalPlanId: "canon-bbbb",
    canonicalConfidence: 0.95,
    insurerCatalogId: "cat-bc-2",
    insurerName: "Blue Cross Blue Shield of Wyoming",
    planName: "BlueSelect Gold Premier",
  }),
);
check(
  "same family + canonical links 0.95/0.95 at DIFFERENT ids → canonical_differs (rule 5 unguarded)",
  sameFamilyDiffCanonical.verdict === "different" &&
    sameFamilyDiffCanonical.reason === "canonical_differs",
  `${sameFamilyDiffCanonical.verdict}/${sameFamilyDiffCanonical.reason}`,
);

const sameFamilySameCanonical = resolvePlanIdentity(
  f({
    canonicalPlanId: "canon-aaaa",
    canonicalConfidence: 0.95,
    insurerCatalogId: "cat-bc-1",
    insurerName: "Blue Cross",
  }),
  f({
    canonicalPlanId: "canon-aaaa",
    canonicalConfidence: 0.95,
    insurerCatalogId: "cat-bc-2",
    insurerName: "Blue Cross Blue Shield of Wyoming",
  }),
);
check(
  "same family + SAME canonical link → same/canonical_match (sanity)",
  sameFamilySameCanonical.verdict === "same" &&
    sameFamilySameCanonical.reason === "canonical_match",
  `${sameFamilySameCanonical.verdict}/${sameFamilySameCanonical.reason}`,
);

/* ── 5. Stub-assembly call-site policy ─────────────────────────────────────── */

check("stub-assembly reason is a stable telemetry key", STUB_ASSEMBLY_REASON === "stub_assembly");

check(
  "assembly: manual stub + same-family doc → assemble (the incident, fixed)",
  shouldAssembleStub({
    reason: "insufficient_signal",
    existingSource: "manual",
    existingPlanName: null,
    existingInsurerName: "Blue Cross",
    parsedInsurerName: "Blue Cross Blue Shield of Wyoming",
  }),
);
check(
  "assembly: insurance_card stub with NO insurer → assemble (nothing to contradict)",
  shouldAssembleStub({
    reason: "insufficient_signal",
    existingSource: "insurance_card",
    existingPlanName: null,
    existingInsurerName: null,
    parsedInsurerName: "Aetna",
  }),
);
check(
  "assembly refused: stub says Cigna, doc says Aetna (real carrier change still prompts)",
  !shouldAssembleStub({
    reason: "insurer_differs",
    existingSource: "manual",
    existingPlanName: null,
    existingInsurerName: "Cigna",
    parsedInsurerName: "Aetna",
  }),
);
check(
  "assembly refused: canonical_differs outranks assembly (two proven catalog plans)",
  !shouldAssembleStub({
    reason: "canonical_differs",
    existingSource: "manual",
    existingPlanName: null,
    existingInsurerName: "Blue Cross",
    parsedInsurerName: "Blue Cross Blue Shield of Wyoming",
  }),
);
check(
  "assembly refused: document-sourced plan is not a stub",
  !shouldAssembleStub({
    reason: "insufficient_signal",
    existingSource: "sbc_upload",
    existingPlanName: null,
    existingInsurerName: "Blue Cross",
    parsedInsurerName: "Blue Cross Blue Shield of Wyoming",
  }),
);
check(
  "assembly refused: a NAMED manual plan is an established identity, not half a pair",
  !shouldAssembleStub({
    reason: "insufficient_signal",
    existingSource: "manual",
    existingPlanName: "BlueSelect Bronze Basic",
    existingInsurerName: "Blue Cross",
    parsedInsurerName: "Blue Cross Blue Shield of Wyoming",
  }),
);
check(
  "assembly refused: stub HAS an insurer but the doc's is unknown (family unprovable → ask)",
  !shouldAssembleStub({
    reason: "insufficient_signal",
    existingSource: "manual",
    existingPlanName: null,
    existingInsurerName: "Blue Cross",
    parsedInsurerName: null,
  }),
);

/* ── 6. The incident, end to end (resolver → call-site policy) ────────────── */

const incident = resolvePlanIdentity(
  // The stub: card scan — luck-resolved catalog id, brand-only name, no plan
  // name, no canonical link.
  f({ insurerCatalogId: "cat-luck-of-the-draw", insurerName: "Blue Cross", planName: null }),
  // The SBC parse: its own entity row; canonical candidate unconfirmed → null.
  f({
    insurerCatalogId: "cat-bcbs-wyoming",
    insurerName: "Blue Cross Blue Shield of Wyoming",
    planName: "BlueSelect Bronze Basic for Individuals",
  }),
);
check(
  "incident: resolver no longer asserts a carrier change",
  incident.reason !== "insurer_differs",
  `${incident.verdict}/${incident.reason}`,
);
check(
  "incident: verdict falls to uncertain — and the call-site assembles instead of prompting",
  incident.verdict === "uncertain" &&
    shouldAssembleStub({
      reason: incident.reason,
      existingSource: "manual",
      existingPlanName: null,
      existingInsurerName: "Blue Cross",
      parsedInsurerName: "Blue Cross Blue Shield of Wyoming",
    }),
  `${incident.verdict}/${incident.reason}`,
);

/* ── 7. Shared card-preservation decision — DB-free fast paths ─────────────
 * (The confident-mismatch leg needs the insurer catalog and is exercised by
 * the existing set-active-canonical paths in dev/E2E, not here — hermetic
 * fixture, no network by design.) ─────────────────────────────────────────── */

void (async () => {
  const assemblyDecision = await decideCardPreservation(explodingSupabase, {
    priorActiveSource: "manual",
    priorInsurerName: "Blue Cross",
    newInsurerName: "Blue Cross Blue Shield of Wyoming",
  });
  check(
    "card-preservation: assembly (manual stub) preserves — and never touches the DB",
    assemblyDecision.assembly && assemblyDecision.preserveCard,
  );

  const noPrior = await decideCardPreservation(explodingSupabase, {
    priorActiveSource: null,
    priorInsurerName: null,
    newInsurerName: "Aetna",
  });
  check("card-preservation: no prior active plan → assembly, preserve", noPrior.preserveCard);

  const familySwitch = await decideCardPreservation(explodingSupabase, {
    priorActiveSource: "sbc_upload",
    priorInsurerName: "Blue Cross",
    newInsurerName: "Blue Cross Blue Shield of Wyoming",
  });
  check(
    "card-preservation: established plan, same-family switch → preserve without a DB hit",
    !familySwitch.assembly && familySwitch.preserveCard,
  );

  const noPriorInsurer = await decideCardPreservation(explodingSupabase, {
    priorActiveSource: "plan_doc_upload",
    priorInsurerName: null,
    newInsurerName: "Aetna",
  });
  check(
    "card-preservation: prior insurer unknown → uncertainty preserves",
    noPriorInsurer.preserveCard,
  );

  console.log(`\n${total} assertions — ${total - failures} passed, ${failures} failed`);
  if (failures > 0) {
    console.error("✗ s292-insurer-family fixture RED");
    process.exit(1);
  }
  console.log("✓ s292-insurer-family fixture green");
})();
