/**
 * Simplified onboarding — fixture (S285).
 *
 * Run:  npx tsx scripts/onboarding-simplified-fixture.ts
 *
 * Asserts, with zero network/DB access:
 *   1. The approved copy deck VERBATIM (reassuring tone — Andrew sign-off via
 *      the 2026-07-17 design handoff; any reword must fail here first).
 *   2. DOB auto-mask behavior (digit stream → M/D/YYYY, backspace passthrough).
 *   3. Validation rules (ZIP 5-digit; DOB real date, 18+, <120).
 *   4. Profile-strength math incl. the 85 "complete" threshold decision.
 *   5. Option slugs stay in lockstep with the mig-208 CHECK constraints.
 *   6. ISO ↔ display DOB conversions round-trip.
 */

import {
  OB_COPY,
  OB_CARD_COPY,
  OB_DOC_COPY,
  OB_METER_COPY,
  OB_METER_ITEMS,
  OB_HOUSEHOLD,
  OB_SITUATIONS,
  OB_SEX,
  OB_STEP_NAMES,
  OB_COMPLETE_THRESHOLD,
  OB_WEIGHTS,
  SIMPLIFIED_ONBOARDING_FLAG,
  obDobOk,
  obDobToIso,
  obDobFromIso,
  obFmtDob,
  obStrength,
  obZipOk,
  slotsFromProfile,
  unwrapDecorated,
  obFmtMoney,
  chipsFromPlanAnalyze,
  chipsFromClaimSummary,
} from "../src/lib/onboarding/simplified";
import { applyDocSupplementMerge, valuesMatch } from "../src/lib/plan/plan-merge";

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

/* ── 1. Approved copy — verbatim ─────────────────────────────────────────── */

eq("flag key", SIMPLIFIED_ONBOARDING_FLAG, "onboarding_simplified_v1");
eq("copy.eyebrow", OB_COPY.eyebrow, "WELCOME TO CANDID");
eq("copy.later", OB_COPY.later, "I'll do this later");
eq("copy.s1Title", OB_COPY.s1Title, "Snap a photo of your insurance card");
eq(
  "copy.s1Sub",
  OB_COPY.s1Sub,
  "It's the fastest way in — we read the card and fill in your insurer, member ID, group number, and copays for you. No typing.",
);
eq("copy.s1TitleManual", OB_COPY.s1TitleManual, "Add your insurance card");
eq(
  "copy.s1SubManual",
  OB_COPY.s1SubManual,
  "Just the IDs from the front of your card — they're the two things no other document has. Or drop a photo and we'll read it for you, copays included.",
);
eq("copy.s1Skip", OB_COPY.s1Skip, "No card handy? Skip — you can add it anytime");
eq("copy.s2Title", OB_COPY.s2Title, "Add a plan document or a bill");
eq(
  "copy.s2Sub",
  OB_COPY.s2Sub,
  "A plan document (SBC, EOC, booklet) fills in your coverage information like deductibles, OOP max, covered services. A bill or EOB gets audited for overcharges on the spot.",
);
eq("copy.s2Skip", OB_COPY.s2Skip, "Skip — we'll keep a reminder on your dashboard");
eq("copy.s3Title", OB_COPY.s3Title, "Last thing — 30 seconds about you");
eq(
  "copy.s3Sub",
  OB_COPY.s3Sub,
  "Just the things documents can't tell us. Everything else, Candid reads on its own.",
);
eq("copy.s3Cta", OB_COPY.s3Cta, "Finish — take me to my dashboard");
eq("copy.continueCta", OB_COPY.continueCta, "Continue");
eq(
  "copy.consequence",
  OB_COPY.consequence,
  "Without a card or plan document, Candid can't audit anything yet. That's okay — your dashboard will show exactly what's missing.",
);
eq("copy.situationLabel", OB_COPY.situationLabel, "What brings you here?");
eq("copy.situationWhy", OB_COPY.situationWhy, "Helps us run the right audit checks first.");

eq("card.dropline", OB_CARD_COPY.dropline, "Faster with a photo?");
eq(
  "card.droplineSub",
  OB_CARD_COPY.droplineSub,
  "Drop or browse a shot of your card — we'll type all of this for you, plus plan type, copays, and Rx codes.",
);
eq("card.scanned", OB_CARD_COPY.scanned, "Card read — details filled in");
eq("card.manualSaved", OB_CARD_COPY.manualSaved, "Details saved");
eq(
  "card.manualNote",
  OB_CARD_COPY.manualNote,
  "Entered manually — a document can verify this later",
);
eq("doc.dropTitle", OB_DOC_COPY.dropTitle, "Drop your plan document or a bill");
eq(
  "meter.nodocsTitle",
  OB_METER_COPY.nodocsTitle,
  "Your audits can't run yet — Candid has no coverage document",
);
eq("meter.nodocsCta", OB_METER_COPY.nodocsCta, "Finish setup");
eq(
  "meter.completeRow",
  OB_METER_COPY.completeRow,
  "Profile complete — every audit runs at full accuracy.",
);
eq("step names", [...OB_STEP_NAMES], ["Insurance card", "Plan document", "About you"]);

eq(
  "situation labels",
  OB_SITUATIONS.map((s) => s.label),
  [
    "ER bill",
    "Surprise / out-of-network bill",
    "Denied claim",
    "Bill seems too high",
    "Looking for hidden plan benefits",
    "Shopping for a plan",
    "Just staying ahead",
  ],
);
eq(
  "household labels",
  OB_HOUSEHOLD.map((h) => h.label),
  ["Just me", "Me + spouse", "Me + kid(s)", "Me + spouse + kid(s)"],
);
eq(
  "sex options",
  OB_SEX.map((s) => `${s.id}:${s.label}`),
  ["female:Female", "male:Male", "prefer_not_to_say:Prefer not to say"],
);

/* ── 2. DOB auto-mask ────────────────────────────────────────────────────── */

eq("mask 7161994", obFmtDob("7161994"), "7/16/1994");
eq("mask 07161994", obFmtDob("07161994"), "07/16/1994");
eq("mask 3311990", obFmtDob("3311990"), "3/31/1990");
eq("mask 01231990", obFmtDob("01231990"), "01/23/1990");
eq("mask 12251990", obFmtDob("12251990"), "12/25/1990");
eq("mask partial 71", obFmtDob("71"), "7/1");
eq("mask backspace passthrough", obFmtDob("7/16/199", "7/16/1994"), "7/16/199");
eq("mask empty", obFmtDob(""), "");

/* ── 3. Validation ───────────────────────────────────────────────────────── */

eq("zip ok", obZipOk("94107"), true);
eq("zip short", obZipOk("9410"), false);
eq("zip alpha", obZipOk("9410a"), false);
eq("zip empty", obZipOk(""), false);

eq("dob valid adult", obDobOk("7/16/1994"), true);
eq("dob padded", obDobOk("07/16/1994"), true);
eq("dob not a date", obDobOk("2/30/1994"), false);
eq("dob malformed", obDobOk("7/16/94"), false);
const thisYear = new Date().getFullYear();
eq("dob under 18", obDobOk(`1/1/${thisYear - 10}`), false);
eq("dob 120+", obDobOk(`1/1/${thisYear - 130}`), false);
eq("dob empty", obDobOk(""), false);

/* ── 4. Strength math + threshold ────────────────────────────────────────── */

const allOff = {
  card: false,
  doc: false,
  household: false,
  zip: false,
  dob: false,
  sex: false,
  situation: false,
};
eq("strength empty", obStrength(allOff), 0);
eq(
  "strength full",
  obStrength({ card: true, doc: true, household: true, zip: true, dob: true, sex: true, situation: true }),
  100,
);
eq("strength card only", obStrength({ ...allOff, card: true }), 30);
const requiredOnly = obStrength({
  card: true,
  doc: true,
  household: true,
  zip: true,
  dob: true,
  sex: false,
  situation: false,
});
eq("strength required-only", requiredOnly, 85);
eq("required-only reaches complete (Q4: declining optionals is an answer)",
  requiredOnly >= OB_COMPLETE_THRESHOLD, true);
eq("threshold value", OB_COMPLETE_THRESHOLD, 85);
eq(
  "weights sum to 100",
  Object.values(OB_WEIGHTS).reduce((a, b) => a + b, 0),
  100,
);
eq("meter items cover every slot", OB_METER_ITEMS.map((i) => i.slot).sort().join(","),
  ["card", "doc", "dob", "household", "sex", "situation", "zip"].sort().join(","));

/* ── 5. Slug ↔ mig-208 CHECK lockstep ────────────────────────────────────── */

import { readFileSync } from "fs";
import { join } from "path";

const mig = readFileSync(
  join(process.cwd(), "supabase/migrations/208_onboarding_simplified_profile_fields.sql"),
  "utf-8",
);
for (const h of OB_HOUSEHOLD) {
  eq(`mig208 household CHECK includes '${h.id}'`, mig.includes(`'${h.id}'`), true);
}
for (const s of OB_SITUATIONS) {
  eq(`mig208 situation CHECK includes '${s.id}'`, mig.includes(`'${s.id}'`), true);
}

/* ── 6. ISO ↔ display conversions ────────────────────────────────────────── */

eq("iso from display", obDobToIso("7/16/1994"), "1994-07-16");
eq("iso from padded display", obDobToIso("07/16/1994"), "1994-07-16");
eq("iso from junk", obDobToIso("junk"), null);
eq("display from iso", obDobFromIso("1994-07-16"), "07/16/1994");
eq("display from null", obDobFromIso(null), "");
eq("roundtrip", obDobFromIso(obDobToIso("7/16/1994")), "07/16/1994");

/* ── 7. slotsFromProfile derivation ──────────────────────────────────────── */

eq(
  "slots: empty profile",
  slotsFromProfile({ profile: null }),
  allOff,
);
eq(
  "slots: member_id counts as card",
  slotsFromProfile({ profile: { member_id: "W1284" } }).card,
  true,
);
eq(
  "slots: hasCard doc counts as card",
  slotsFromProfile({ hasCard: true, profile: null }).card,
  true,
);
eq(
  "slots: doc slot from hasPlanOrBill",
  slotsFromProfile({ hasPlanOrBill: true, profile: null }).doc,
  true,
);
eq(
  "slots: full profile",
  slotsFromProfile({
    hasCard: true,
    hasPlanOrBill: true,
    profile: {
      member_id: "X",
      household: "just_me",
      zip_code: "94107",
      date_of_birth: "1994-07-16",
      sex: "male",
      situation_tags: ["er_bill"],
    },
  }),
  { card: true, doc: true, household: true, zip: true, dob: true, sex: true, situation: true },
);

/* ── 7. Decorated-value unwrap (S286 crash guard) ────────────────────────────
   /api/plan/analyze returns display-state objects ({value,state,reason,…}) for
   matched/active plans; the doc-step chips must unwrap to the scalar or a raw
   object leaks into a React child and crashes the flow. */
const decoratedNum = { value: 1500, state: "user_verified", reason: "from_user_document_cite_grade", hasExcerpt: true, excerpt: "$1,500", searchedSectionsCount: 3 };
const decoratedStr = { value: "PPO", state: "user_verified", reason: "from_user_document_cite_grade", hasExcerpt: false, excerpt: null };
eq("unwrap decorated number", unwrapDecorated(decoratedNum), 1500);
eq("unwrap decorated string", unwrapDecorated(decoratedStr), "PPO");
eq("unwrap decorated null value", unwrapDecorated({ value: null, state: "missing", reason: "not_found", hasExcerpt: false, excerpt: null }), null);
eq("unwrap raw number passthrough", unwrapDecorated(1500), 1500);
eq("unwrap raw string passthrough", unwrapDecorated("PPO"), "PPO");
eq("unwrap null passthrough", unwrapDecorated(null), null);
eq("unwrap undefined passthrough", unwrapDecorated(undefined), undefined);

/* ── 8. Supplement-merge matrix (S286 — Andrew-approved policy) ──────────────
   process-plan's mergeIntoExistingPlan branch: each subsequent doc parse
   SUPPLEMENTS the row — fill gaps · never erase · weak (manual/uncited)
   incumbents yield to a cited parse · matches CONFIRM (corroboration
   recorded) · conflicts resolve per DOCUMENT (more complete wins, tie →
   newest). */
eq("doc.settling copy", OB_DOC_COPY.settling, "Pulling in your results…");

eq("valuesMatch: numeric string vs number", valuesMatch("3000", 3000), true);
eq("valuesMatch: case/whitespace-insensitive", valuesMatch("PPO ", "ppo"), true);
eq("valuesMatch: zero is a real value", valuesMatch(0, "0"), true);
eq("valuesMatch: different numbers", valuesMatch(3000, 6000), false);
eq("valuesMatch: null never matches", valuesMatch(null, null), false);

{
  // Fill + weak-incumbent + never-erase in one pass (the S286 chimera shape).
  const r = applyDocSupplementMerge({
    base: { source: "sbc_upload", is_active: true },
    docFields: {
      in_oop_max_family: 6000, // existing empty → fill
      insurer_name: "Cigna", // existing "Test", uncited → doc wins
      plan_type: null, // this parse didn't extract → never erase
    },
    existingRow: { in_oop_max_family: null, insurer_name: "Test", plan_type: "HMO" },
    existingProvenance: {},
    parseProvenance: {
      in_oop_max_family: { source: "doc_extraction" },
      insurer_name: { source: "doc_extraction" },
    },
    documentId: "doc-1",
  });
  eq("supplement: fill lands", r.update.in_oop_max_family, 6000);
  eq("supplement: uncited incumbent yields to cited parse", r.update.insurer_name, "Cigna");
  eq("supplement: parsed-null never erases", "plan_type" in r.update, false);
  eq("supplement: no conflict resolution triggered", r.conflictWinner, null);
  eq("supplement: base fields preserved", r.update.source, "sbc_upload");
  eq("supplement: fill action", r.actions.in_oop_max_family, "fill");
  eq("supplement: weak action", r.actions.insurer_name, "doc_wins_weak");
  eq(
    "supplement: parse provenance adopted for fill + weak",
    r.update.field_provenance,
    {
      in_oop_max_family: { source: "doc_extraction" },
      insurer_name: { source: "doc_extraction" },
    },
  );
}

{
  // Manual-source incumbent yields to doc (CF-25); no parse provenance → no map churn.
  const r = applyDocSupplementMerge({
    base: {},
    docFields: { in_deductible_individual: 500 },
    existingRow: { in_deductible_individual: 1000 },
    existingProvenance: { in_deductible_individual: { source: "manual" } },
    parseProvenance: {},
    documentId: "doc-1",
  });
  eq("supplement: manual incumbent yields to doc", r.update.in_deductible_individual, 500);
  eq("supplement: manual-loses action", r.actions.in_deductible_individual, "doc_wins_weak");
  eq("supplement: no prov change → no field_provenance write", "field_provenance" in r.update, false);
}

{
  // Confirm — two documents agree: keep value + original citation, record corroboration.
  const r = applyDocSupplementMerge({
    base: {},
    docFields: { in_deductible_individual: "3000" },
    existingRow: { in_deductible_individual: 3000 },
    existingProvenance: {
      in_deductible_individual: { source: "doc_extraction", source_excerpt: "original" },
    },
    parseProvenance: {
      in_deductible_individual: { source: "doc_extraction", source_excerpt: "second read" },
    },
    documentId: "doc-2",
  });
  eq("confirm: value not rewritten", "in_deductible_individual" in r.update, false);
  eq("confirm: action", r.actions.in_deductible_individual, "confirm");
  eq(
    "confirm: original citation kept + corroboration recorded",
    r.update.field_provenance,
    {
      in_deductible_individual: {
        source: "doc_extraction",
        source_excerpt: "original",
        corroborated_by: ["doc-2"],
      },
    },
  );
  // Same doc confirming again is a no-op (dedup).
  const r2 = applyDocSupplementMerge({
    base: {},
    docFields: { in_deductible_individual: 3000 },
    existingRow: { in_deductible_individual: 3000 },
    existingProvenance: {
      in_deductible_individual: { source: "doc_extraction", corroborated_by: ["doc-2"] },
    },
    parseProvenance: {},
    documentId: "doc-2",
  });
  eq("confirm: corroboration dedups", "field_provenance" in r2.update, false);
}

{
  // Conflict, new parse more complete → conflicting fields flip TOGETHER; fills still apply.
  const r = applyDocSupplementMerge({
    base: {},
    docFields: { plan_name: "OAP Buy Up", plan_type: "OAP", plan_year: 2026, in_deductible_individual: 0 },
    existingRow: { plan_name: "Kaiser Gold", plan_type: "HMO", plan_year: null, in_deductible_individual: null },
    existingProvenance: {
      plan_name: { source: "doc_extraction" },
      plan_type: { source: "doc_extraction" },
    },
    parseProvenance: { plan_name: { source: "doc_extraction" } },
    documentId: "doc-3",
  });
  eq("conflict: new more complete — plan_name flips", r.update.plan_name, "OAP Buy Up");
  eq("conflict: per-document — plan_type flips with it", r.update.plan_type, "OAP");
  eq("conflict: winner recorded", r.conflictWinner, "new");
  eq("conflict: fills apply alongside", r.update.plan_year, 2026);
  eq("conflict: zero-value fill applies", r.update.in_deductible_individual, 0);
  eq("conflict: action", r.actions.plan_name, "conflict_new_wins");
}

{
  // Conflict, incumbent more complete → incumbent kept (whole document loses).
  const r = applyDocSupplementMerge({
    base: {},
    docFields: { plan_name: "Sparse Doc" },
    existingRow: {
      plan_name: "Rich Plan",
      plan_type: "PPO",
      in_deductible_individual: 1000,
      in_oop_max_individual: 5000,
    },
    existingProvenance: {
      plan_name: { source: "doc_extraction" },
      plan_type: { source: "doc_extraction" },
      in_deductible_individual: { source: "doc_extraction" },
      in_oop_max_individual: { source: "doc_extraction" },
    },
    parseProvenance: { plan_name: { source: "doc_extraction" } },
    documentId: "doc-4",
  });
  eq("conflict: incumbent more complete → kept", "plan_name" in r.update, false);
  eq("conflict: winner recorded existing", r.conflictWinner, "existing");
  eq("conflict: kept action", r.actions.plan_name, "conflict_existing_kept");
}

{
  // Equal completeness → newest (this parse) wins.
  const r = applyDocSupplementMerge({
    base: {},
    docFields: { plan_name: "New Name" },
    existingRow: { plan_name: "Old Name" },
    existingProvenance: { plan_name: { source: "doc_extraction" } },
    parseProvenance: {},
    documentId: "doc-5",
  });
  eq("conflict: equal completeness → newest wins", r.update.plan_name, "New Name");
  eq("conflict: tie winner recorded", r.conflictWinner, "new");
}

/* ── 9. Result-chip builders (S286 — ONE shaping for live path + restore) ─── */

eq("fmtMoney: number", obFmtMoney(1500), "$1,500");
eq("fmtMoney: numeric string", obFmtMoney("250.4"), "$250");
eq("fmtMoney: zero is real", obFmtMoney(0), "$0");
eq("fmtMoney: garbage", obFmtMoney("abc"), null);
eq("fmtMoney: null", obFmtMoney(null), null);

eq(
  "plan chips: decorated values unwrap + full set",
  chipsFromPlanAnalyze({
    totalBenefits: 38,
    planSummary: {
      inDeductible: { value: 1500, state: "user_verified", reason: "x", hasExcerpt: false, excerpt: null },
      inOopMax: 5000,
      planType: { value: "PPO", state: "user_verified", reason: "x", hasExcerpt: false, excerpt: null },
    },
  }),
  [
    { label: "Deductible", value: "$1,500", verified: true },
    { label: "OOP max", value: "$5,000", verified: true },
    { label: "Plan type", value: "PPO" },
    { label: "Covered services", value: "38 indexed" },
  ],
);
eq("plan chips: empty analyze → no chips", chipsFromPlanAnalyze({}), []);

eq(
  "bill chips: full claim",
  chipsFromClaimSummary({
    lineItemCount: 5,
    findingCount: 2,
    providerName: "Mercy",
    recovery: { potentialRecovery: 703.52 },
  }),
  [
    { label: "Potential recovery", value: "$704", verified: true },
    { label: "Line items", value: "5" },
    { label: "Findings", value: "2" },
    { label: "Provider", value: "Mercy" },
  ],
);
eq("bill chips: no claim → empty", chipsFromClaimSummary(null), []);

/* ── Result ──────────────────────────────────────────────────────────────── */

console.log(`\n${passed + failed} assertions — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("✓ onboarding-simplified fixture green");
