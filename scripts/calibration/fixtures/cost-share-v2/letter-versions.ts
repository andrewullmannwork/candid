/**
 * Cost-Share v2 (W4 + Finding 4) — letter version-history + evidence-fingerprint
 * cost-share-drift fixtures.
 * Locks appendLetterVersion: newest-last, cap (drop-oldest), empty-content no-op, null-safe.
 * Locks computeEvidenceFingerprint: a cost-share correction (coverage / plan
 * params / accumulator / override / network / ACA / per-line numbers) drifts the
 * hash; row reorder + float noise are stable; an absent basis is byte-identical
 * to the pre-Finding-4 hash.
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/letter-versions.ts
 */
import {
  appendLetterVersion,
  computeEvidenceFingerprint,
  isDisputeStale,
  type LetterVersion,
  type FingerprintInput,
  type CostShareBasis,
} from "../../../../src/lib/disputes/evidence-fingerprint";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)}`);
}
const v = (c: string): LetterVersion => ({ content: c, fingerprint: `fp_${c}`, savedAt: `2026-06-24T00:0${c}:00Z` });

// 1 — append to empty (null history) → [entry]
{
  const r = appendLetterVersion(null, v("1"));
  check("1 null history → single entry", r.length === 1 && r[0].content === "1", r);
}

// 2 — append within cap → grows, newest LAST
{
  const r = appendLetterVersion([v("1"), v("2")], v("3"));
  check("2 grows to 3, newest last", r.length === 3 && r[2].content === "3" && r[0].content === "1", r);
}

// 3 — append OVER cap (3) → drop oldest, keep newest 3
{
  const r = appendLetterVersion([v("1"), v("2"), v("3")], v("4"));
  check("3 caps at 3", r.length === 3, r.length);
  check("3 drops oldest (1 gone)", r[0].content === "2" && r[2].content === "4", r.map((x) => x.content));
}

// 4 — empty content → no-op (don't store an absent letter)
{
  const base = [v("1")];
  const r = appendLetterVersion(base, { content: "", fingerprint: null, savedAt: "x" });
  check("4 empty content is a no-op", r.length === 1 && r[0].content === "1", r);
}

// 5 — undefined history is null-safe
{
  const r = appendLetterVersion(undefined, v("9"));
  check("5 undefined history → [entry]", r.length === 1 && r[0].content === "9", r);
}

// 6 — custom cap honored
{
  const r = appendLetterVersion([v("1"), v("2")], v("3"), 2);
  check("6 cap=2 keeps newest 2", r.length === 2 && r[0].content === "2" && r[1].content === "3", r.map((x) => x.content));
}

// ── Cost-Share v2 (Finding 4) — evidence-fingerprint cost-share drift ─────────
// The hash must drift on ANY cost-share input change (so a correction flags the
// persistent letter stale) yet stay byte-identical with no basis (flag OFF) and
// stable under DB row reordering / float noise.
const baseInput: FingerprintInput = {
  findings: [],
  lineItems: [],
  totalRecoveryEstimate: 0,
};
const baseBasis: CostShareBasis = {
  plan: {
    params: {
      inDeductibleIndividual: 1500,
      inDeductibleFamily: 3000,
      outDeductibleIndividual: 3000,
      outDeductibleFamily: 6000,
      inOopMaxIndividual: 8000,
      inOopMaxFamily: 16000,
      outOopMaxIndividual: 16000,
      outOopMaxFamily: 32000,
      inCoinsuranceDefault: 0.2,
      outCoinsuranceDefault: 0.4,
      deductibleCalcMethod: "embedded",
      combinedMedicalRxOop: true,
      coverageTier: "individual",
    },
    coverage: [
      { slug: "office_visit", covered: true, copay: 30, coinsurance: null, deductibleApplies: false, outCopay: null, outCoinsurance: 0.4, outDeductibleApplies: true, oonPaidAtInNetwork: false },
      { slug: "preventive_care", covered: true, copay: 0, coinsurance: 0, deductibleApplies: false, outCopay: null, outCoinsurance: null, outDeductibleApplies: null, oonPaidAtInNetwork: null },
    ],
    acaCompliant: null,
  },
  claim: {
    dateOfService: "2024-03-15",
    networkStatus: "in_network",
    userNetworkOverride: null,
    totalBilled: 500,
    totalInsurancePaid: 0,
    amountStillOutstanding: 163.27,
    totalPatientResponsibility: 163.27,
    insurancePlanId: "plan-1",
    userPatientPaid: null,
    userTotalsSource: null,
  },
  lines: [
    { lineNumber: 1, billedAmount: 221, insuranceAdjustedAmount: 57.73, insurancePaid: 0, patientPaidAmount: 163.27, patientOwes: 163.27, amountStillOutstanding: 0, memberAppliedToDeductible: 163.27, memberCoinsurance: 0, memberCopay: 0, deniedAmount: 0, networkStatus: "in_network", billingCode: "99213", billingCodeType: "CPT", coverageUserConfirmed: false, coverageUserRejected: false },
  ],
  accumulators: [
    { benefitYear: "2024", networkTier: "in_network", accumulatorType: "medical", isIndividual: true, deductibleApplied: 500, deductibleMax: 1500, oopApplied: 500, oopMax: 8000 },
  ],
  overrides: { deductibleMet: null, deductibleMetAsOf: null, oopMet: null, oopMetAsOf: null, userNetworkOverride: null },
};
const cloneBasis = (b: CostShareBasis): CostShareBasis =>
  JSON.parse(JSON.stringify(b)) as CostShareBasis;
const withBasis = (b: CostShareBasis): FingerprintInput => ({ ...baseInput, costShareBasis: b });
const fp = (i: FingerprintInput) => computeEvidenceFingerprint(i);

// F1 — no basis on both → identical (flag-OFF byte-identical path)
check("F1 absent basis identical", fp(baseInput) === fp({ ...baseInput }));
// F2 — adding the basis actually changes the hash (it's folded in)
check("F2 basis folds into hash", fp(withBasis(baseBasis)) !== fp(baseInput));
// F3 — identical basis → identical hash (determinism)
check("F3 identical basis deterministic", fp(withBasis(baseBasis)) === fp(withBasis(cloneBasis(baseBasis))));
// F4 — coverage copay edit (AddPlanDetails) drifts
{ const b = cloneBasis(baseBasis); b.plan.coverage[0].copay = 40; check("F4 coverage copay drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F5 — adding a covered service drifts
{ const b = cloneBasis(baseBasis); b.plan.coverage.push({ slug: "specialist_visit", covered: true, copay: 50, coinsurance: null, deductibleApplies: false, outCopay: null, outCoinsurance: null, outDeductibleApplies: null, oonPaidAtInNetwork: null }); check("F5 coverage add drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F6 — plan deductible edit (/api/plan/field) drifts
{ const b = cloneBasis(baseBasis); if (b.plan.params) b.plan.params.inDeductibleIndividual = 2000; check("F6 plan param drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F7 — the ACA answer (null → true) drifts
{ const b = cloneBasis(baseBasis); b.plan.acaCompliant = true; check("F7 ACA flag drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F8 — accumulator OOP edit drifts
{ const b = cloneBasis(baseBasis); b.accumulators[0].oopApplied = 8000; check("F8 accumulator drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F9 — deductible-met override (editor toggle) drifts
{ const b = cloneBasis(baseBasis); b.overrides.deductibleMet = true; b.overrides.deductibleMetAsOf = "2024-01-01"; check("F9 override drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F10 — network override drifts
{ const b = cloneBasis(baseBasis); b.claim.userNetworkOverride = "out_of_network"; check("F10 network override drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F11 — a re-parse moving the bill's own numbers drifts (cf91a49e class)
{ const b = cloneBasis(baseBasis); b.lines[0].billedAmount = 240; check("F11 per-line billed drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F12 — per-line billing-code change drifts (preventive membership keys on code)
{ const b = cloneBasis(baseBasis); b.lines[0].billingCode = "99396"; check("F12 per-line code drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F13 — claim insurer-paid-$0 signal drifts
{ const b = cloneBasis(baseBasis); b.claim.totalInsurancePaid = 50; check("F13 claim insurer-paid drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F14 — coverage row ORDER permuted → SAME hash (sort stability)
{ const b = cloneBasis(baseBasis); b.plan.coverage.reverse(); check("F14 coverage order stable", fp(withBasis(b)) === fp(withBasis(baseBasis))); }
// F15 — accumulator ORDER permuted → SAME hash
{ const b = cloneBasis(baseBasis); b.accumulators.push({ benefitYear: "2023", networkTier: "out_of_network", accumulatorType: "medical", isIndividual: true, deductibleApplied: 0, deductibleMax: 3000, oopApplied: 0, oopMax: 16000 }); const b2 = cloneBasis(b); b2.accumulators.reverse(); check("F15 accumulator order stable", fp(withBasis(b)) === fp(withBasis(b2))); }
// F16 — float-noise money == rounded money (cents canonicalization)
{ const b = cloneBasis(baseBasis); b.lines[0].patientPaidAmount = 163.27000000001; check("F16 money float-noise stable", fp(withBasis(b)) === fp(withBasis(baseBasis))); }
// F17 — coinsurance: sub-4dp float noise stable; a real change drifts
{ const b = cloneBasis(baseBasis); if (b.plan.params) b.plan.params.inCoinsuranceDefault = 0.2000000001; check("F17a coins float-noise stable", fp(withBasis(b)) === fp(withBasis(baseBasis))); }
{ const b = cloneBasis(baseBasis); if (b.plan.params) b.plan.params.inCoinsuranceDefault = 0.25; check("F17b coins real drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F18 — S293 (#6): the aggregate "Looks right" per-line confirm mark drifts the
// hash (the letter CITES confirmed borrows — dispute 80a705ac's zero-clause
// letter never flagged stale because the old hash was blind to this mark).
{ const b = cloneBasis(baseBasis); b.lines[0].coverageUserConfirmed = true; check("F18 coverage-confirm mark drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F19 — S293 (#6): a per-line "doesn't match" rejection drifts (it EXCLUDES a citation).
{ const b = cloneBasis(baseBasis); b.lines[0].coverageUserRejected = true; check("F19 coverage-reject mark drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }
// F20 — S293 (#6): the user-confirmed amount-paid override drifts (recovery input).
{ const b = cloneBasis(baseBasis); b.claim.userPatientPaid = 146.21; check("F20 userPatientPaid drift", fp(withBasis(b)) !== fp(withBasis(baseBasis))); }

// ── isDisputeStale — the SHARED staleness rule (dispute card == letter page) ──
// §17.4: the claim GET (the card) and the dispute GET (the letter) MUST agree on
// "out of date". Locking the one rule both surfaces call guarantees no drift.
const FP_X = "x".repeat(64);
const FP_Y = "y".repeat(64);
check("S1 drift → stale", isDisputeStale({ currentFingerprint: FP_X, storedFingerprint: FP_Y, sentAt: null }) === true);
check("S2 fingerprints match → not stale", isDisputeStale({ currentFingerprint: FP_X, storedFingerprint: FP_X, sentAt: null }) === false);
check("S3 sent → not stale even when drifted", isDisputeStale({ currentFingerprint: FP_X, storedFingerprint: FP_Y, sentAt: "2026-06-20T00:00:00Z" }) === false);
check("S4 null current (claim unloadable) → not stale", isDisputeStale({ currentFingerprint: null, storedFingerprint: FP_Y, sentAt: null }) === false);
check("S5 just-regenerated → not stale", isDisputeStale({ currentFingerprint: FP_X, storedFingerprint: FP_Y, sentAt: null, justRegenerated: true }) === false);
check("S6 null stored (never fingerprinted) → stale", isDisputeStale({ currentFingerprint: FP_X, storedFingerprint: null, sentAt: null }) === true);

console.log(`\ncost-share-v2 letter-version + fingerprint fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
