/**
 * savings-derivation — S307. The "what you could save" panel explains itself.
 *
 * Pins the ONE derivation behind savings_math_derivation_v1 (v7 mock, all
 * approved): the plan card's priced answer + per-line term/dollar rows + proof
 * pill (≥2 and ≤3 charged lines, all priced); the bill card's state model
 * (recovery headline gate, paid/balance splits with their zero-companion
 * rules, dividers and equations that sum on screen); the strip sentences
 * (deductible-aware, approved copy verbatim); the spread sentence's provenance
 * gate; and the banner tense fix. Dollars in = dollars out: the helper renders
 * engine results, it never computes money (splits are pure complements:
 * yours = paid − refund, legit = balance − forgiveness).
 *
 * Run: npx tsx scripts/calibration/fixtures/claims/savings-derivation.ts
 */
import {
  buildSavingsDerivation,
  type DerivationLineInput,
} from "../../../../src/lib/claims/savings-derivation";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

function line(id: string, over: Partial<DerivationLineInput> = {}): DerivationLineInput {
  return {
    id,
    label: id,
    serviceSlug: id,
    billed: 100,
    adjustedBilled: 100,
    paid: 0,
    stillBilled: 0,
    shouldOwe: 0,
    refund: 0,
    forgiveness: 0,
    rateKnown: true,
    copay: null,
    coinsurance: null,
    covered: true,
    deductibleApplies: null,
    deductibleMet: null,
    deductibleMax: null,
    ...over,
  };
}

const base = { prorated: false, paidTotal: 0, balanceTotal: 0, refundComponent: 0, forgivenessComponent: 0 };

// ── State A — the 8/21 claim, real current state (both lines priced) ────────
{
  const visit = line("visit", {
    label: "Primary Care Visit",
    serviceSlug: "pcp_visit",
    billed: 480,
    adjustedBilled: 219.52,
    paid: 52.82,
    shouldOwe: 0,
    refund: 52.82,
    copay: 0,
  });
  const injections = line("inj", {
    label: "Allergy Serum / Injection",
    serviceSlug: "allergy_injection",
    billed: 924,
    adjustedBilled: 422.57,
    paid: 101.67,
    shouldOwe: 422.57,
    coinsurance: 0.2,
    deductibleApplies: true,
    deductibleMet: false,
    deductibleMax: 2000,
  });
  const zeroTracking = line("bp", { label: "BP tracking", billed: 0 });

  const d = buildSavingsDerivation({
    lines: [injections, zeroTracking, visit],
    prorated: true,
    paidTotal: 154.49,
    balanceTotal: 0,
    refundComponent: 52.82,
    forgivenessComponent: 0,
  });

  check("charged lines only become rows ($0 tracking excluded)", d.rows.length === 2, d.rows.length);
  check("priced count = 2 of 2 (a known rate in a deductible phase IS priced)", d.pricedCount === 2 && d.chargedCount === 2);
  check("big number sums priced shouldOwe (0 + 422.57)", d.pricedShouldOwe === 422.57, d.pricedShouldOwe);
  check("big label — Andrew's copy, all priced", d.bigLabel === "owed based on your plan", d.bigLabel);
  check(
    "proof pill — row order, sums to the big number",
    d.planPill === "$422.57 + $0.00 = the $422.57 owed ✓",
    d.planPill,
  );

  const i = d.rows.find((r) => r.id === "inj")!;
  check("injections term cell", i.planTerm === "20% after deductible", i.planTerm);
  check("injections amount cell", i.planAmountText === "$422.57", i.planAmountText);
  check("injections is not flagged unpriced", i.unpriced === false);
  check(
    "injections strip sentence — the tightened approved copy",
    i.planDetail ===
      "Your plan says: covered — 20% after your $2,000.00 deductible. It isn't met, so up to $422.57 is yours to pay.",
    i.planDetail,
  );
  check(
    "injections result — deductible spending, not unprovable overpayment",
    i.result.kind === "none" && i.resultNone === "counts toward your deductible",
    i.resultNone,
  );
  check("injections (priced) carries NO CTA", i.cta === false);

  const v = d.rows.find((r) => r.id === "visit")!;
  check("visit term cell — approved words, columnized", v.planTerm === "no copay", v.planTerm);
  check("visit amount cell", v.planAmountText === "$0.00", v.planAmountText);
  check("visit strip sentence", v.planDetail === "Your plan says: covered, no copay — you owe $0.", v.planDetail);
  check("visit result: You're Owed $52.82", v.result.kind === "owed_back" && v.result.amount === 52.82 && v.resultLabel === "You're Owed");

  check(
    "spread sentence renders when prorated, naming the paid total",
    d.spreadSentence === "Your bill reports payments only as one total, so we split $154.49 across the charged lines by their share of the bill.",
    d.spreadSentence,
  );
  check("banner refund sub — tense fix", d.refundSub === "+$52.82 refund to request", d.refundSub);
  check("banner forgiveness sub absent under $1", d.forgivenessSub === null);

  // Bill card — state 1 (paid, refund-shaped)
  check("bill: recovery headline on", d.bill.recoveryHeadline === true);
  check("bill: charged to you = paid + balance", d.bill.chargedToYou === 154.49, d.bill.chargedToYou);
  check("bill: paid split present", d.bill.paidSplit !== null);
  check("bill: paid divider", d.bill.paidSplit!.divider === "Where your $154.49 went", d.bill.paidSplit!.divider);
  check("bill: yours = paid − refund", d.bill.paidSplit!.yours === 101.67, d.bill.paidSplit!.yours);
  check(
    "bill: paid equation sums on screen",
    d.bill.paidSplit!.equation === "$101.67 + $52.82 = the $154.49 you paid ✓",
    d.bill.paidSplit!.equation,
  );
  check("bill: single split carries the $0.00 forgiveness companion", d.bill.paidSplit!.forgivenessZero === true);
  check("bill: no balance split on a settled bill", d.bill.balanceSplit === null);
}

// ── Bill card state 2 — unpaid, forgiveness-shaped ──────────────────────────
{
  const d = buildSavingsDerivation({
    ...base,
    lines: [line("visit", { billed: 480, stillBilled: 52.82, forgiveness: 52.82, copay: 0 })],
    paidTotal: 0,
    balanceTotal: 154.49,
    forgivenessComponent: 52.82,
  });
  check("state 2: recovery headline on", d.bill.recoveryHeadline === true);
  check("state 2: no paid split (nothing paid)", d.bill.paidSplit === null);
  check("state 2: balance divider", d.bill.balanceSplit!.divider === "Where the $154.49 balance stands", d.bill.balanceSplit!.divider);
  check("state 2: legit = balance − forgiveness", d.bill.balanceSplit!.legit === 101.67, d.bill.balanceSplit!.legit);
  check(
    "state 2: balance equation",
    d.bill.balanceSplit!.equation === "$101.67 + $52.82 = the $154.49 balance ✓",
    d.bill.balanceSplit!.equation,
  );
  check("state 2: single split carries the $0.00 refund companion", d.bill.balanceSplit!.refundZero === true);
  check("state 2: banner forgiveness sub — approved copy", d.forgivenessSub === "$52.82 to remove from your balance", d.forgivenessSub);
}

// ── Bill card state 3 — partially paid, both buckets ────────────────────────
{
  const d = buildSavingsDerivation({
    ...base,
    lines: [line("a", { billed: 100 })],
    paidTotal: 100,
    balanceTotal: 54.49,
    refundComponent: 20,
    forgivenessComponent: 32.82,
  });
  check("state 3: both splits present", d.bill.paidSplit !== null && d.bill.balanceSplit !== null);
  check("state 3: paid equation", d.bill.paidSplit!.equation === "$80.00 + $20.00 = the $100.00 you paid ✓", d.bill.paidSplit!.equation);
  check(
    "state 3: balance equation",
    d.bill.balanceSplit!.equation === "$21.67 + $32.82 = the $54.49 balance ✓",
    d.bill.balanceSplit!.equation,
  );
  check("state 3: NO zero-companion rows in either split", d.bill.paidSplit!.forgivenessZero === false && d.bill.balanceSplit!.refundZero === false);
  check("state 3: charged = paid + balance", d.bill.chargedToYou === 154.49, d.bill.chargedToYou);
}

// ── Bill card state 4 — nothing recoverable ─────────────────────────────────
{
  const d = buildSavingsDerivation({
    ...base,
    lines: [line("a", { billed: 100, paid: 20, shouldOwe: 20, copay: 20 })],
    paidTotal: 20,
    balanceTotal: 0,
  });
  check("state 4: no recovery headline", d.bill.recoveryHeadline === false);
  check("state 4: no splits at all", d.bill.paidSplit === null && d.bill.balanceSplit === null);
  check("state 4: charged still derived", d.bill.chargedToYou === 20);
}

// ── Plan card label + pill rules ────────────────────────────────────────────
{
  const priced = (id: string) => line(id, { copay: 10, shouldOwe: 10 });
  const unpriced = line("u", { rateKnown: false, adjustedBilled: 422.57 });

  const partial = buildSavingsDerivation({ ...base, lines: [priced("a"), unpriced] });
  check("partial pricing → 'so far' label", partial.bigLabel === "owed based on your plan, so far", partial.bigLabel);
  check("partial pricing → NO proof pill (a range is bounds, not a sum term)", partial.planPill === null);
  check("unpriced term cell", partial.rows[1].planTerm === "unpriced", partial.rows[1].planTerm);
  check("unpriced amount cell is the range", partial.rows[1].planAmountText === "$0–$422.57", partial.rows[1].planAmountText);
  check("unpriced row flagged for red styling", partial.rows[1].unpriced === true);
  check("unpriced (with slug) carries the CTA", partial.rows[1].cta === true);
  check(
    "unpriced sentence — maximum-until-you-confirm copy",
    partial.rows[1].planDetail === "We don't know your rate for this service, so we assume the maximum until you confirm: up to $422.57.",
    partial.rows[1].planDetail,
  );
  check("unpriced keeps 'nothing provable yet' (no deductible claim)", partial.rows[1].resultNone === "nothing provable yet");

  const single = buildSavingsDerivation({ ...base, lines: [priced("a")] });
  check("single charged line → no one-term pill", single.planPill === null);

  const three = buildSavingsDerivation({ ...base, lines: [priced("a"), priced("b"), priced("c")] });
  check("three priced lines → pill with three terms", three.planPill === "$10.00 + $10.00 + $10.00 = the $30.00 owed ✓", three.planPill);

  const four = buildSavingsDerivation({ ...base, lines: [priced("a"), priced("b"), priced("c"), priced("d")] });
  check("four charged lines → no pill (readability cap)", four.planPill === null);
  check("four lines all priced → still the all-priced label", four.bigLabel === "owed based on your plan");
}

// ── Wording variants + honesty gates (carried) ──────────────────────────────
{
  const copay = line("c", { copay: 30, shouldOwe: 30 });
  const coins = line("k", { coinsurance: 0.2, shouldOwe: 20 });
  const notCovered = line("n", { covered: false, shouldOwe: 100 });
  const copayUnmet = line("cu", { copay: 30, shouldOwe: 200, deductibleApplies: true, deductibleMet: false, deductibleMax: 2000 });
  const coinsMet = line("km", { coinsurance: 0.2, shouldOwe: 20, deductibleApplies: true, deductibleMet: true, deductibleMax: 2000 });
  const noMaxUnmet = line("nm", { coinsurance: 0.1, shouldOwe: 50, deductibleApplies: true, deductibleMet: false });
  const d = buildSavingsDerivation({
    ...base,
    lines: [copay, coins, notCovered, copayUnmet, coinsMet, noMaxUnmet],
  });
  check("copay term", d.rows[0].planTerm === "$30.00 copay", d.rows[0].planTerm);
  check("coinsurance term", d.rows[1].planTerm === "20% coinsurance", d.rows[1].planTerm);
  check("not-covered term + its owed dollar", d.rows[2].planTerm === "not covered" && d.rows[2].planAmountText === "$100.00");
  check("copay + unmet deductible term", d.rows[3].planTerm === "$30.00 copay after deductible", d.rows[3].planTerm);
  check(
    "copay + unmet deductible sentence",
    d.rows[3].planDetail === "Your plan says: covered — a $30.00 copay after your $2,000.00 deductible. It isn't met, so up to $200.00 is yours to pay.",
    d.rows[3].planDetail,
  );
  check("copay + unmet result label", d.rows[3].resultNone === "counts toward your deductible");
  check(
    "coinsurance + deductible MET sentence — approved copy",
    d.rows[4].planDetail === "Your plan says: covered — you pay 20% of the allowed amount. Your deductible is met.",
    d.rows[4].planDetail,
  );
  check(
    "unmet with UNKNOWN deductible dollars drops the figure, keeps the fact",
    d.rows[5].planDetail === "Your plan says: covered — 10% after your deductible. It isn't met, so up to $50.00 is yours to pay.",
    d.rows[5].planDetail,
  );
  check("no detail sentence names a source when none is passed", !d.rows[0].planDetail.includes("Source:"));
  check("cite-grade per-line bills carry NO spread sentence", d.spreadSentence === null);
}

// ── Result precedence + CTA edges (carried) ─────────────────────────────────
{
  const noSlug = line("ns", { rateKnown: false, serviceSlug: null });
  const mixed = line("mx", { paid: 40, refund: 10, forgiveness: 5, stillBilled: 20 });
  const subDollar = line("sd", { paid: 10, refund: 0.4 });
  const unpaid = line("up", { paid: 0, stillBilled: 52.82, forgiveness: 52.82, copay: 0 });
  const d = buildSavingsDerivation({
    ...base,
    lines: [noSlug, mixed, subDollar, unpaid],
    paidTotal: 50,
    balanceTotal: 72.82,
    refundComponent: 10,
    forgivenessComponent: 57.82,
  });
  check("unpriced WITHOUT a service identity gets no CTA (modal precondition)", d.rows[0].cta === false);
  check("mixed line: refund outranks forgiveness", d.rows[1].result.kind === "owed_back" && d.rows[1].result.amount === 10);
  check("sub-$1 result is none, not a penny row", d.rows[2].result.kind === "none");
  check("unpaid line speaks in balance relief", d.rows[3].paidLabel === "Still billed" && d.rows[3].resultLabel === "Off your balance");
  check("banner shows both subs when both components ≥ $1", d.refundSub !== null && d.forgivenessSub !== null);
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`savings-derivation: ${pass}/${total} passed`);
  for (const f of fails) console.error(f);
  process.exit(1);
}
console.log(`savings-derivation: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
