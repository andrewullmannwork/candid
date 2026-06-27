/**
 * R3 step 3 — obligation-registry-parity: the gate for the condition-gated obligation registry.
 * Oracles are authored from the DESIGN (cost_share_v2 §18.10.A + the [[Candid_Data_Principles]] §1
 * Evidence Disclosure rules), NOT re-derived from the implementation — no circular self-grading.
 *
 *   1. SELECTOR LOGIC — synthetic elements with deliberately DISTINCT voices, so each branch's
 *      output is unambiguous (can't coincidentally match). Covers the 4 branches + all 4 predicates
 *      (proves evalObligationPredicate reads the right ctx field).
 *   2. SEEDING — a hand-authored §18.10.A table → assert every per-ground + claim-level element's
 *      {party, condition, voiceIfMet, voiceIfNot} matches (catches a mis-seed independently).
 *   3. renderObligationClauses — recipient filtering · null-ctx → the verbatim live NSA clause ·
 *      predicate-met → demand · flag-gate · multi-clause · contracted_rate omit-when-unknown.
 *   4. buildRequestSection THREADING — a real balance_billing ask, both recipients → the registry's
 *      fall_to_facts NSA clause is PRESENT in the composed live letter (registry→letter wiring tie).
 *   5. buildObligationContext() — all four predicates null (the default-safe seam).
 *
 * Byte-identity of the live letter is golden-corpus's job; this proves the MECHANISM + the seeding.
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/obligation-registry-parity.ts
 */
import {
  DISPUTE_GROUND_CATALOG,
  CLAIM_LEVEL_OBLIGATIONS,
  selectObligationVoice,
  type ObligationElement,
  type ObligationContext,
  type ObligationPredicate,
} from "../../../../src/lib/disputes/dispute-ground-catalog";
import {
  buildObligationContext,
  renderObligationClauses,
} from "../../../../src/lib/disputes/obligation-render";
import { buildRequestSection } from "../../../../src/lib/disputes/templates";
import type {
  DisputeEvidence,
  LineItemEvidence,
  ClaimEvidence,
} from "../../../../src/lib/disputes/evidence-resolver";
import type { DisputeGroundType } from "../../../../src/lib/disputes/dispute-grounds";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}

// The verbatim live NSA clause (templates.ts balance_billing ask) — pinned exactly: it must not drift.
const NSA_FALL = "apply any applicable No Surprises Act protections";

// ── 1. SELECTOR LOGIC (synthetic elements, distinct voices → unambiguous branches) ───────────
{
  const synth = (
    condition: ObligationPredicate | null,
    voiceIfMet: ObligationElement["voiceIfMet"],
    voiceIfNot: ObligationElement["voiceIfNot"],
  ): ObligationElement => ({ element: "_synth", party: "insurer", authority: "_", condition, voiceIfMet, voiceIfNot });

  // Conditional element with distinct voices (demand vs omit).
  const cond = synth("nsa_applicable", "demand", "omit");
  check("LOGIC conditional · unknown · ON → voiceIfNot (Evidence Disclosure safety)",
    selectObligationVoice(cond, { nsaApplicable: null }, true) === "omit",
    selectObligationVoice(cond, { nsaApplicable: null }, true));
  check("LOGIC conditional · met · ON → voiceIfMet",
    selectObligationVoice(cond, { nsaApplicable: true }, true) === "demand",
    selectObligationVoice(cond, { nsaApplicable: true }, true));
  check("LOGIC conditional · false · ON → voiceIfNot",
    selectObligationVoice(cond, { nsaApplicable: false }, true) === "omit",
    selectObligationVoice(cond, { nsaApplicable: false }, true));
  check("LOGIC conditional · met · OFF → voiceIfNot (flag gate)",
    selectObligationVoice(cond, { nsaApplicable: true }, false) === "omit",
    selectObligationVoice(cond, { nsaApplicable: true }, false));

  // Unconditional certain element (condition null) — always voiceIfMet, ignores flag + predicates.
  const uncond = synth(null, "raise", "omit");
  check("LOGIC null-condition · OFF → voiceIfMet (federal certain ships regardless of flag)",
    selectObligationVoice(uncond, {}, false) === "raise",
    selectObligationVoice(uncond, {}, false));
  check("LOGIC null-condition · predicate irrelevant · ON → voiceIfMet",
    selectObligationVoice(uncond, { nsaApplicable: false }, true) === "raise",
    selectObligationVoice(uncond, { nsaApplicable: false }, true));

  // Predicate-field coverage: each predicate's evaluator must read ITS OWN ctx field. Condition on
  // predicate P, set ONLY P true → demand; set a DIFFERENT field true (P still null) → omit.
  const PREDS: ObligationPredicate[] = ["nsa_applicable", "contract_exists", "statute_verified", "rate_known"];
  const CTX_KEY: Record<ObligationPredicate, keyof ObligationContext> = {
    nsa_applicable: "nsaApplicable",
    contract_exists: "contractExists",
    statute_verified: "statuteVerified",
    rate_known: "rateKnown",
  };
  for (const p of PREDS) {
    const el = synth(p, "demand", "omit");
    const metCtx: ObligationContext = { [CTX_KEY[p]]: true };
    check(`LOGIC predicate ${p} · own field true · ON → demand`,
      selectObligationVoice(el, metCtx, true) === "demand",
      selectObligationVoice(el, metCtx, true));
    // A different predicate's field true, P's field null → still safe (P unknown).
    const other = p === "rate_known" ? "nsa_applicable" : "rate_known";
    const wrongCtx: ObligationContext = { [CTX_KEY[other]]: true };
    check(`LOGIC predicate ${p} · only OTHER field set · ON → voiceIfNot (no cross-read)`,
      selectObligationVoice(el, wrongCtx, true) === "omit",
      selectObligationVoice(el, wrongCtx, true));
  }
}

// ── 2. SEEDING ORACLE (hand-authored §18.10.A → assert the catalog matches) ───────────────────
type Row = {
  element: string;
  party: "insurer" | "provider";
  condition: ObligationPredicate | null;
  voiceIfMet: ObligationElement["voiceIfMet"];
  voiceIfNot: ObligationElement["voiceIfNot"];
};
const EXPECTED_SEEDING: Record<DisputeGroundType, Row[]> = {
  service_not_rendered: [
    { element: "proof_of_service_rendered", party: "provider", condition: null, voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
  ],
  balance_billing: [
    { element: "nsa_protection", party: "insurer", condition: "nsa_applicable", voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
    { element: "nsa_protection", party: "provider", condition: "nsa_applicable", voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
    { element: "contracted_rate_apply", party: "insurer", condition: "contract_exists", voiceIfMet: "demand", voiceIfNot: "omit" },
  ],
  duplicate: [],
  unbundling: [],
  coverage_contradiction: [
    { element: "plan_provision_basis", party: "insurer", condition: null, voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
  ],
  cost_share_misapplication: [
    { element: "deductible_oop_accumulator", party: "insurer", condition: null, voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
  ],
  benchmark: [],
  unallocated_balance: [],
  coding_peer: [
    { element: "coding_review", party: "provider", condition: null, voiceIfMet: "raise", voiceIfNot: "omit" },
  ],
};
const EXPECTED_CLAIM_LEVEL: Row[] = [
  { element: "itemized_statement", party: "provider", condition: "statute_verified", voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
  { element: "eob", party: "insurer", condition: null, voiceIfMet: "demand", voiceIfNot: "fall_to_facts" },
];

function assertSeeding(label: string, got: readonly ObligationElement[], want: Row[]) {
  check(`SEED ${label} count == ${want.length}`, got.length === want.length, got.length);
  for (let i = 0; i < want.length; i++) {
    const g = got[i];
    const w = want[i];
    if (!g) { check(`SEED ${label}[${i}] present`, false); continue; }
    check(`SEED ${label}[${i}] ${w.element} {party,condition,voiceIfMet,voiceIfNot}`,
      g.element === w.element && g.party === w.party && g.condition === w.condition &&
      g.voiceIfMet === w.voiceIfMet && g.voiceIfNot === w.voiceIfNot,
      { element: g.element, party: g.party, condition: g.condition, voiceIfMet: g.voiceIfMet, voiceIfNot: g.voiceIfNot });
    check(`SEED ${label}[${i}] ${w.element} authority non-empty`, g.authority.length > 0);
  }
}
for (const ground of Object.keys(EXPECTED_SEEDING) as DisputeGroundType[]) {
  assertSeeding(ground, DISPUTE_GROUND_CATALOG[ground].obligationElements, EXPECTED_SEEDING[ground]);
}
assertSeeding("CLAIM_LEVEL", CLAIM_LEVEL_OBLIGATIONS, EXPECTED_CLAIM_LEVEL);

// ── 3. renderObligationClauses (balance_billing) ─────────────────────────────────────────────
{
  const NULL = buildObligationContext();
  // null ctx → fall_to_facts (the verbatim live clause), both recipients; contracted_rate omit-dropped.
  const insOff = renderObligationClauses("balance_billing", "insurer", NULL, false);
  check("RENDER insurer · null ctx → [NSA fall_to_facts]", insOff.length === 1 && insOff[0] === NSA_FALL, insOff);
  const provOff = renderObligationClauses("balance_billing", "provider", NULL, false);
  check("RENDER provider · null ctx → [NSA fall_to_facts]", provOff.length === 1 && provOff[0] === NSA_FALL, provOff);

  // nsa met + ON → a DIFFERENT (demand) NSA clause; contracted_rate still omit (contractExists null).
  const insNsa = renderObligationClauses("balance_billing", "insurer", { nsaApplicable: true }, true);
  check("RENDER insurer · nsa met · ON → 1 demand clause (contracted omit)", insNsa.length === 1, insNsa);
  check("RENDER insurer · nsa met · ON → NSA demand ≠ fall_to_facts",
    insNsa[0] !== NSA_FALL && (insNsa[0]?.includes("No Surprises Act") ?? false), insNsa[0]);

  // flag gate: nsa met but demands OFF → back to fall_to_facts.
  const insGate = renderObligationClauses("balance_billing", "insurer", { nsaApplicable: true }, false);
  check("RENDER insurer · nsa met · OFF → fall_to_facts (flag gate)", insGate.length === 1 && insGate[0] === NSA_FALL, insGate);

  // multi-clause: nsa + contract both met · ON · insurer → [nsa demand, contracted demand].
  const insBoth = renderObligationClauses("balance_billing", "insurer", { nsaApplicable: true, contractExists: true }, true);
  check("RENDER insurer · nsa+contract met · ON → 2 demand clauses", insBoth.length === 2, insBoth);
  check("RENDER insurer · 2-clause includes contracted-rate demand",
    insBoth.some((c) => c.includes("contracted")), insBoth);

  // recipient filter: contracted_rate is insurer-only → provider gets only the nsa clause.
  const provBoth = renderObligationClauses("balance_billing", "provider", { nsaApplicable: true, contractExists: true }, true);
  check("RENDER provider · nsa+contract met · ON → 1 clause (contracted is insurer-only)", provBoth.length === 1, provBoth);
}

// ── 4. buildRequestSection THREADING (registry → live composed letter) ────────────────────────
{
  const line: LineItemEvidence = {
    lineItemId: "li-bb", billingCode: { value: "80053", type: "CPT" }, serviceSlug: "lab_panel",
    serviceName: "Lab panel", billedAmount: 300, insurancePaid: 100, patientOwes: 200, patientPaid: 0,
    planBenefit: null, expectedPatientCost: null, actualPatientCost: 200, discrepancyAmount: 50,
    discrepancyReason: null, communityOutcome: null, siblingCodes: null, pricingBenchmark: null,
    auditFindings: [{
      type: "balance_billing", severity: "high", title: "Balance billed",
      description: "Billed above the allowed amount.", estimatedOvercharge: 50, benchmarkAmount: null, benchmarkSource: null,
    }],
    auditRan: true, peerCodes: null, disputeType: "balance_billing", citeGradeTier: "header",
    dollarAtStake: 50, serviceNotRenderedAttested: false, secondaryCoverageVerify: null,
  };
  const claim = {
    claimId: "c-1", dateOfService: "2024-03-15", providerName: "Sample Medical Center",
    totalBilled: 300, planYear: 2024, lineItemEvidence: [line],
    effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  } satisfies ClaimEvidence;
  const evidence: DisputeEvidence = {
    claims: [claim],
    totals: { claimCount: 1, lineItemCount: 1, totalBilled: 300, totalDiscrepancy: 50 },
    planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
    dataTrust: { headerReconciliationFailed: false, signViolation: false },
  };
  for (const recipient of ["insurer", "provider"] as const) {
    const off = buildRequestSection({ evidence, planContext: null, recipient, demandsEnabled: false });
    check(`THREAD ${recipient} · registry NSA fall_to_facts present in live letter`, off.includes(NSA_FALL));
    // demandsEnabled ON but predicates null (buildObligationContext all-null) → unchanged (no leak).
    const on = buildRequestSection({ evidence, planContext: null, recipient, demandsEnabled: true });
    check(`THREAD ${recipient} · demandsEnabled ON + no data → still fall_to_facts (no demand leak)`, on.includes(NSA_FALL));
  }
}

// ── 5. buildObligationContext() — the default-safe seam (all predicates null) ─────────────────
{
  const ctx = buildObligationContext();
  check("CTX all four predicates null (default-safe)",
    ctx.nsaApplicable === null && ctx.contractExists === null &&
    ctx.statuteVerified === null && ctx.rateKnown === null, ctx);
}

console.log(`\nobligation-registry-parity: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
