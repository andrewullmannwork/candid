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
 *      predicate-met → demand · flag-gate · contracted_rate PROSE-LESS (the data-aware copy owns it).
 *   4. buildRequestSection THREADING — a real balance_billing ask, both recipients → the registry's
 *      fall_to_facts NSA clause is PRESENT in the live letter; + decision ⑥ (ON==OFF byte-identical
 *      with no contracted-rate signal → the safe flip).
 *   5. buildObligationContext(lines) — empty → all-null (default-safe); an allowed-rate gap lights
 *      rateKnown, an in-network/tiered gap lights contractExists (the Item B data seam).
 *   6. Item B contracted-rate ask — buildRequestSection renders the right copy per network tier ×
 *      recipient when demandsEnabled; byte-inert when OFF / no allowed-rate (the flag gate).
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
  const PREDS: ObligationPredicate[] = ["nsa_applicable", "contract_exists", "statute_verified", "rate_known", "published_rate_exceeded"];
  const CTX_KEY: Record<ObligationPredicate, keyof ObligationContext> = {
    nsa_applicable: "nsaApplicable",
    contract_exists: "contractExists",
    statute_verified: "statuteVerified",
    rate_known: "rateKnown",
    published_rate_exceeded: "publishedRateExceeded",
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
    { element: "contracted_rate_apply", party: "provider", condition: "contract_exists", voiceIfMet: "demand", voiceIfNot: "omit" },
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
  chargemaster: [
    { element: "published_rate_ceiling", party: "provider", condition: "published_rate_exceeded", voiceIfMet: "raise", voiceIfNot: "omit" },
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
  const NULL = buildObligationContext([]);
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

  // R3 5.4 Phase 3 (Item B) — contracted_rate_apply is now PROSE-LESS: its copy is the data-aware
  // ask in templates (tested in §6), so renderObligationClauses emits NO contracted clause even when
  // contractExists is met + demands ON. Both recipients therefore yield ONLY the nsa demand clause
  // (provider now ALSO carries a contracted_rate_apply element, but prose-less → nothing). Locks the
  // data-aware split: the registry decides the VOICE; it does not emit the contracted COPY.
  const insBoth = renderObligationClauses("balance_billing", "insurer", { nsaApplicable: true, contractExists: true }, true);
  check("RENDER insurer · nsa+contract met · ON → 1 clause (contracted_rate prose-less)", insBoth.length === 1, insBoth);
  check("RENDER · contract met · ON → NO contracted clause emitted (data-aware owns the copy)",
    !insBoth.some((c) => c.includes("contracted")), insBoth);
  const provBoth = renderObligationClauses("balance_billing", "provider", { nsaApplicable: true, contractExists: true }, true);
  check("RENDER provider · nsa+contract met · ON → 1 clause (contracted_rate prose-less)", provBoth.length === 1, provBoth);

  // R3 step 5.4 (recipient dimension) — provider_financial_assistance is the INERT additive slot: no
  // element targets it yet, so it renders nothing even with every predicate met + demands ON. Locks
  // the type widening as byte-inert until the charity/FA fast-follow wires an element to it.
  const faInert = renderObligationClauses("balance_billing", "provider_financial_assistance", { nsaApplicable: true, contractExists: true }, true);
  check("RENDER provider_financial_assistance · all met · ON → [] (no FA element yet — inert slot)", faInert.length === 0, faInert);
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
    // demandsEnabled ON but no allowed-rate signal on the line → unchanged (no leak).
    const on = buildRequestSection({ evidence, planContext: null, recipient, demandsEnabled: true });
    check(`THREAD ${recipient} · demandsEnabled ON + no data → still fall_to_facts (no demand leak)`, on.includes(NSA_FALL));
    // Decision ⑥ — the ON==OFF SAFE-FLIP assertion: with NO contracted-rate signal on the evidence,
    // flipping demandsEnabled changes NOTHING (byte-identical). This is what makes flipping
    // dispute_grounds_v1 safe absent data; Item B's behavior change rides ONLY a real allowed-rate.
    check(`THREAD ${recipient} · ⑥ ON===OFF byte-identical (no contracted-rate signal → safe flip)`, off === on, { offLen: off.length, onLen: on.length });
  }
}

// ── 5. buildObligationContext(lines) — the data seam: empty/no-signal → all-null (default-safe);
//    an allowed-rate gap lights rateKnown; an in-network/tiered gap lights contractExists (Item B). ─
{
  const empty = buildObligationContext([]);
  check("CTX empty lines → all four predicates null (default-safe)",
    empty.nsaApplicable === null && empty.contractExists === null &&
    empty.statuteVerified === null && empty.rateKnown === null, empty);

  const mkLine = (allowed: number | null, network: LineItemEvidence["networkStatus"], billed = 300): LineItemEvidence => ({
    lineItemId: "x", billingCode: null, serviceSlug: null, serviceName: "x", billedAmount: billed,
    insurancePaid: null, patientOwes: null, patientPaid: null, allowedAmount: allowed, networkStatus: network,
    planBenefit: null, expectedPatientCost: null, actualPatientCost: null, discrepancyAmount: null,
    discrepancyReason: null, communityOutcome: null, siblingCodes: null, pricingBenchmark: null,
    auditFindings: null, auditRan: false, peerCodes: null, disputeType: "balance_billing",
    citeGradeTier: "header", dollarAtStake: 0,
  });

  // in-network + allowed below billed → BOTH contractExists + rateKnown (a proven participating contract).
  const inNet = buildObligationContext([mkLine(200, "in_network")]);
  check("CTX in-network gap → contractExists=true, rateKnown=true", inNet.contractExists === true && inNet.rateKnown === true, inNet);
  const tier = buildObligationContext([mkLine(200, "tiered")]);
  check("CTX tiered gap → contractExists=true", tier.contractExists === true, tier);
  // OON + gap → rateKnown only; contractExists stays null (absence of proof = unknown, NOT false).
  const oon = buildObligationContext([mkLine(200, "out_of_network")]);
  check("CTX OON gap → rateKnown=true, contractExists=null (no proven contract)", oon.rateKnown === true && oon.contractExists === null, oon);
  const unk = buildObligationContext([mkLine(200, null)]);
  check("CTX unknown gap → rateKnown=true, contractExists=null", unk.rateKnown === true && unk.contractExists === null, unk);
  // allowed present but NO gap (allowed >= billed) → neither lights.
  const noGap = buildObligationContext([mkLine(300, "in_network")]);
  check("CTX no gap (allowed==billed) → contractExists=null, rateKnown=null", noGap.contractExists === null && noGap.rateKnown === null, noGap);
  // no allowed amount (the common bill-only case) → neither lights.
  const noAllowed = buildObligationContext([mkLine(null, "in_network")]);
  check("CTX no allowed → contractExists=null, rateKnown=null", noAllowed.contractExists === null && noAllowed.rateKnown === null, noAllowed);
  // nsaApplicable / statuteVerified always null (await Care + citation registry).
  check("CTX nsaApplicable/statuteVerified always null (future)", inNet.nsaApplicable === null && inNet.statuteVerified === null, inNet);
}

// ── 6. Item B (contracted-rate, data-aware) — buildRequestSection renders the right ask per network
//    tier × recipient when demandsEnabled; byte-inert when OFF / no allowed-rate (the flag gate). ──
{
  const mkEv = (allowed: number | null, network: LineItemEvidence["networkStatus"]): DisputeEvidence => {
    const line: LineItemEvidence = {
      lineItemId: "li-cr", billingCode: { value: "99214", type: "CPT" }, serviceSlug: "office_visit",
      serviceName: "Office visit", billedAmount: 300, insurancePaid: 0, patientOwes: 100, patientPaid: 0,
      allowedAmount: allowed, networkStatus: network,
      planBenefit: null, expectedPatientCost: null, actualPatientCost: 100, discrepancyAmount: 100,
      discrepancyReason: null, communityOutcome: null, siblingCodes: null, pricingBenchmark: null,
      auditFindings: [{
        type: "balance_billing", severity: "high", title: "Balance billed",
        description: "Billed above the allowed amount.", estimatedOvercharge: 100, benchmarkAmount: null, benchmarkSource: null,
      }],
      auditRan: true, peerCodes: null, disputeType: "balance_billing", citeGradeTier: "header",
      dollarAtStake: 100, serviceNotRenderedAttested: false, secondaryCoverageVerify: null,
    };
    const claim = {
      claimId: "c-cr", dateOfService: "2024-05-01", providerName: "Sample Medical Center",
      totalBilled: 300, planYear: 2024, lineItemEvidence: [line],
      effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
      dataTrust: { headerReconciliationFailed: false, signViolation: false },
    } satisfies ClaimEvidence;
    return {
      claims: [claim], totals: { claimCount: 1, lineItemCount: 1, totalBilled: 300, totalDiscrepancy: 100 },
      planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
      dataTrust: { headerReconciliationFailed: false, signViolation: false },
    };
  };
  const on = (ev: DisputeEvidence, recipient: "insurer" | "provider") => buildRequestSection({ evidence: ev, planContext: null, recipient, demandsEnabled: true });
  const BASE_PROV = "Limit my responsibility for this service to my in-network cost-sharing";

  // in-network → STRONG contracted-rate demand (replaces the base ask; NSA omitted — OON protection).
  const inProv = on(mkEv(200, "in_network"), "provider");
  check("ITEMB in-network provider → strong contract copy",
    inProv.includes("My plan shows this provider as in-network") && inProv.includes("may not bill me the difference") && inProv.includes("Please reduce this charge to"), inProv);
  check("ITEMB in-network provider → NSA omitted (in-network ≠ OON protection)", !inProv.includes(NSA_FALL), inProv);
  check("ITEMB in-network provider → base ask replaced", !inProv.includes(BASE_PROV), inProv);
  const inIns = on(mkEv(200, "in_network"), "insurer");
  check("ITEMB in-network insurer → strong contract copy",
    inIns.includes("Your records show") && inIns.includes("at a contracted rate of") && inIns.includes("as your network agreement requires"), inIns);

  // tiered → also strong (participating = proven contract).
  const tierProv = on(mkEv(200, "tiered"), "provider");
  check("ITEMB tiered provider → strong contract copy", tierProv.includes("Their contract rate") && tierProv.includes("payment in full"), tierProv);

  // out-of-network → SUPPRESS (no contract to invoke) → base ask + NSA.
  const oonProv = on(mkEv(200, "out_of_network"), "provider");
  check("ITEMB OON provider → suppressed → base ask present", oonProv.includes(BASE_PROV), oonProv);
  check("ITEMB OON provider → NSA present (base ask)", oonProv.includes(NSA_FALL), oonProv);
  check("ITEMB OON provider → no contract/factual copy",
    !oonProv.includes("My plan shows this provider as in-network") && !oonProv.includes("My plan's allowed amount for"), oonProv);

  // unknown / null network → FACTUAL allowed-amount request (no contract asserted).
  const unkProv = on(mkEv(200, null), "provider");
  check("ITEMB unknown provider → factual allowed-amount copy",
    unkProv.includes("My plan's allowed amount for") && unkProv.includes("itemize any portion"), unkProv);
  check("ITEMB unknown provider → no contract assertion", !unkProv.includes("may not bill me the difference"), unkProv);
  const unkIns = on(mkEv(200, "unknown"), "insurer");
  check("ITEMB unknown insurer → factual copy",
    unkIns.includes("my plan allowed") && unkIns.includes("calculated on the allowed amount"), unkIns);

  // flag gate + no-fire: demandsEnabled OFF + signal, no allowed-rate, or no gap → base ask (inert).
  const inProvOff = buildRequestSection({ evidence: mkEv(200, "in_network"), planContext: null, recipient: "provider", demandsEnabled: false });
  check("ITEMB flag OFF + signal → base ask (no contracted copy)", inProvOff.includes(BASE_PROV) && !inProvOff.includes("may not bill me the difference"), inProvOff);
  const noRate = on(mkEv(null, "in_network"), "provider");
  check("ITEMB no allowed-rate + ON → base ask (no fire)", noRate.includes(BASE_PROV) && !noRate.includes("may not bill me the difference"), noRate);
  const noGap = on(mkEv(300, "in_network"), "provider");
  check("ITEMB allowed==billed (no gap) + ON → base ask (no fire)", noGap.includes(BASE_PROV) && !noGap.includes("may not bill me the difference"), noGap);
}

// ── 7. Item C (chargemaster, data-aware) — buildRequestSection renders the RAISE-voice chargemaster
//    ask when a `chargemaster` finding (benchmarkAmount < billed) is present + demandsEnabled; byte-inert
//    when OFF (the flag gate) or when no finding. Provider cites "your hospital's own chargemaster";
//    insurer cites "its own chargemaster". (The detector/NPI-match upstream is proven by runaudit-smoke.) ─
{
  const mkEv = (avg: number | null): DisputeEvidence => {
    const line: LineItemEvidence = {
      lineItemId: "li-cm", billingCode: { value: "70450", type: "CPT" }, serviceSlug: "ct_head",
      serviceName: "CT Head", billedAmount: 9000, insurancePaid: 0, patientOwes: 9000, patientPaid: 0,
      planBenefit: null, expectedPatientCost: null, actualPatientCost: 9000, discrepancyAmount: 0,
      discrepancyReason: null, communityOutcome: null, siblingCodes: null, pricingBenchmark: null,
      auditFindings: avg != null ? [{
        type: "chargemaster", severity: "medium", title: "Charge above the provider's published rate",
        description: "Billed above the provider's published average charge.",
        estimatedOvercharge: 9000 - avg, benchmarkAmount: avg, benchmarkSource: "Provider chargemaster (Hospital Price Transparency)",
      }] : null,
      auditRan: true, peerCodes: null, disputeType: "benchmark", citeGradeTier: "header",
      dollarAtStake: 0, serviceNotRenderedAttested: false, secondaryCoverageVerify: null,
    };
    const claim = {
      claimId: "c-cm", dateOfService: "2024-06-01", providerName: "Woodland Memorial Hospital",
      totalBilled: 9000, planYear: 2024, lineItemEvidence: [line],
      effectiveTotals: {} as unknown as ClaimEvidence["effectiveTotals"],
      dataTrust: { headerReconciliationFailed: false, signViolation: false },
    } satisfies ClaimEvidence;
    return {
      claims: [claim], totals: { claimCount: 1, lineItemCount: 1, totalBilled: 9000, totalDiscrepancy: 0 },
      planEvidence: null, networkEvidence: null, communityEvidence: null, legalBasis: [], gaps: [],
      dataTrust: { headerReconciliationFailed: false, signViolation: false },
    };
  };
  const onP = buildRequestSection({ evidence: mkEv(4733), planContext: null, recipient: "provider", demandsEnabled: true });
  check("ITEMC provider ON → chargemaster RAISE ask (cites own chargemaster + published pricing)",
    onP.includes("Your hospital's own chargemaster lists an average charge of") && onP.includes("bring my bill in line with your own published pricing"), onP);
  const onI = buildRequestSection({ evidence: mkEv(4733), planContext: null, recipient: "insurer", demandsEnabled: true });
  check("ITEMC insurer ON → chargemaster ask (cites its own chargemaster, don't-pass-through)",
    onI.includes("average charge on its own chargemaster") && onI.includes("exceeds the provider's published pricing"), onI);
  // flag gate: OFF → no chargemaster copy (byte-inert) — the same evidence flips clean.
  const offP = buildRequestSection({ evidence: mkEv(4733), planContext: null, recipient: "provider", demandsEnabled: false });
  check("ITEMC provider OFF → no chargemaster copy (flag gate)", !offP.includes("own chargemaster"), offP);
  // no chargemaster finding + ON → not rendered (the detector hasn't fired; no hospital_hpt seed match).
  const noFind = buildRequestSection({ evidence: mkEv(null), planContext: null, recipient: "provider", demandsEnabled: true });
  check("ITEMC no finding + ON → not rendered", !noFind.includes("own chargemaster"), noFind);
}

console.log(`\nobligation-registry-parity: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
