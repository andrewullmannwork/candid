/**
 * savings-derivation — S307. The "what you could save" panel explains itself.
 *
 * The panel's defect (Andrew, S307): the left card led with the SUM of
 * worst-case shares ("$422.57 your responsibility") beside the bill's actual
 * "$154.49 charged to you", while the refund derived from a per-line,
 * one-directional rule neither card showed. Both numbers were right; the view
 * answered "how much could I owe?" when the user asks "why is the refund what
 * it is?" — and the ceiling headline misread as an entitlement even to us.
 *
 * This module is the ONE derivation for the redesigned panel (flag
 * `savings_math_derivation_v1`): the plan card's priced answer, the per-line
 * plan-answer rows, and the "Where these numbers come from" strip all come
 * from here, so the card can never disagree with the strip. It renders — it
 * never computes money. Every dollar in its output is the engine's own
 * per-line result (`computeRecoveryV2` / `computeCostShareV2`, already on the
 * wire per line); re-deriving any of it here would be the duplicate-derivation
 * drift class this codebase keeps killing.
 *
 * Honesty rules carried over:
 *   - The big number is the plan's PRICED answer — shouldOwe summed over
 *     rate-known lines only, labeled with the count ("owed on the lines your
 *     plan prices today (1 of 2)"). Never a fabricated best-case floor: with
 *     unknown rates the floor is $0, which is the display twin of the
 *     coalesce-unknown-to-0 bug the engine exists to prevent (cf91a49e).
 *   - Unpriced lines state their bracket ("unpriced · $0–$422.57") and carry
 *     the Confirm-your-rate ask (the EXISTING AddPlanDetailsModal — the CTA
 *     needs the line's service identity, so it only renders with a slug).
 *   - The spread sentence renders ONLY when amounts are header-prorated
 *     (S140 provenance made visible); cite-grade per-line bills skip it.
 *
 * PURE — no DB, no clock, no React. Exercised by
 * scripts/calibration/fixtures/claims/savings-derivation.ts.
 */

const fmtMoney = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface DerivationLineInput {
  id: string;
  /** Humanized service label ("Office visit (new patient)"). */
  label: string;
  /** Gates the Confirm-your-rate CTA — the modal requires a service identity. */
  serviceSlug: string | null;
  /** Raw billed. $0 lines (tracking codes) never become rows. */
  billed: number;
  /** Allowed/adjusted amount — the unpriced bracket's ceiling. */
  adjustedBilled: number | null;
  /** Engine outputs for this line (recovery.*). */
  paid: number;
  stillBilled: number;
  shouldOwe: number;
  refund: number;
  forgiveness: number;
  /** False when the line carries a `service_cost` assumption (rate unknown). */
  rateKnown: boolean;
  /** Plan terms, for the answer WORDING only (dollars come from the engine). */
  copay: number | null;
  /** Decimal fraction 0–1. */
  coinsurance: number | null;
  covered: boolean | null;
  /**
   * S307 round 2 (Andrew's screenshot) — the deductible facts, from the line's
   * OWN assumptions (`deductible_applies` / `deductible_met`, already on the
   * wire). Without them the sentence said "you pay 20% of the allowed amount"
   * beside "nothing provable yet", omitting the one fact connecting a known
   * rate to a full-allowed shouldOwe: the unmet deductible eats the line first.
   */
  deductibleApplies: boolean | null;
  /** true = met · false = not met · null = unknown/absent. */
  deductibleMet: boolean | null;
  deductibleMax: number | null;
  /** Optional cite label ("Plan SBC — Primary Care Visit"); appended when present. */
  sourceLabel?: string | null;
}

export interface DerivationRow {
  id: string;
  label: string;
  /** Plan-card term cell ("20% after deductible", "no copay", "unpriced"). */
  planTerm: string;
  /**
   * S309 F2 — the line-items table's PLAN-SAYS sub-line ("10% after
   * deductible · not met", "$30.00 copay — no deductible"). Null on
   * unpriced/not-covered lines (the table stays quiet there). Composed beside
   * `planTerm` in planAnswerFor so the panel and the table share ONE wording
   * derivation.
   */
  planTermCell: string | null;
  /** Plan-card amount cell, pre-formatted ("$422.57", "$0.00", "$0–$422.57" for unpriced). */
  planAmountText: string;
  /** True → the term renders red and the amount is a range, never a sum term. */
  unpriced: boolean;
  /** Full sentence for the strip. */
  planDetail: string;
  paidLabel: "You paid" | "Still billed";
  paidAmount: number;
  /** none → `resultNone` renders; otherwise `resultLabel` + amount. */
  result: { kind: "owed_back" | "off_balance" | "none"; amount: number };
  resultLabel: "You're Owed" | "Off your balance" | null;
  /** "counts toward your deductible" on rate-known deductible-unmet lines; else "nothing provable yet". */
  resultNone: "nothing provable yet" | "counts toward your deductible" | null;
  /** Render the Confirm-your-rate chip (unpriced + has a service identity). */
  cta: boolean;
}

export interface BillCardModel {
  /** recovery ≥ $1 → "+$X potential recovery" headline; else today's charged-to-you headline. */
  recoveryHeadline: boolean;
  /** The bill's total demand on the user (= paid + open balance). */
  chargedToYou: number;
  /**
   * "Where your $X went" — renders when paid ≥ $1 AND refund ≥ $1.
   * `forgivenessZero` = show the $0.00 forgiveness companion row (only when the
   * balance split is absent, so the single split tells the whole story).
   */
  paidSplit: {
    divider: string;
    yours: number;
    refund: number;
    /** S309 F17 — the slice paid ABOVE what the bill charged: the PROVIDER's
     *  refund (its own letter track), never the insurer-claimable refund.
     *  0 when the user paid at or under the charge. */
    overpaid: number;
    forgivenessZero: boolean;
    equation: string;
  } | null;
  /** "Where the $X balance stands" — renders when balance ≥ $1 AND forgiveness ≥ $1. */
  balanceSplit: {
    divider: string;
    legit: number;
    forgiveness: number;
    refundZero: boolean;
    equation: string;
  } | null;
}

export interface SavingsDerivation {
  rows: DerivationRow[];
  chargedCount: number;
  pricedCount: number;
  /** The plan card's big number: shouldOwe summed over PRICED lines only. */
  pricedShouldOwe: number;
  /** "owed based on your plan" · partial pricing appends ", so far". */
  bigLabel: string;
  /**
   * The plan card's proof pill ("$422.57 + $0.00 = the $422.57 owed ✓") —
   * only when EVERY charged line is priced (a range is bounds, not a sum term)
   * and the bill has ≤3 charged lines (longer equations stop being readable).
   */
  planPill: string | null;
  /** The bill card's state model (v7 mock rules, fixture-pinned). */
  bill: BillCardModel;
  /** Present only when amounts are header-prorated. */
  spreadSentence: string | null;
  /** Banner sub-spans (tense fix): null when the component is < $1. */
  refundSub: string | null;
  forgivenessSub: string | null;
}

function planAnswerFor(line: DerivationLineInput): { term: string; amountText: string; detail: string; cell: string | null } {
  const src = line.sourceLabel ? ` Source: ${line.sourceLabel}.` : "";
  const owe = `$${fmtMoney(line.shouldOwe)}`;
  if (!line.rateKnown) {
    const cap = fmtMoney(Math.max(0, line.adjustedBilled ?? line.billed));
    return {
      term: "unpriced",
      amountText: `$0–$${cap}`,
      detail: `We don't know your rate for this service, so we assume the maximum until you confirm: up to $${cap}.`,
      cell: null,
    };
  }
  if (line.covered === false) {
    return {
      term: "not covered",
      amountText: owe,
      detail: `Your plan says: not covered — this line is yours to pay.${src}`,
      cell: null,
    };
  }
  // Deductible-aware wording (approved S307 round 2). Only explicit met-state
  // changes the sentence; unknown stays generic rather than guessing.
  const dedUnmet = line.deductibleApplies === true && line.deductibleMet === false;
  const dedMet = line.deductibleApplies === true && line.deductibleMet === true;
  const dedDollar = line.deductibleMax != null ? ` your $${fmtMoney(line.deductibleMax)} deductible` : " your deductible";
  // S309 F2 (V4, Andrew's phrasing) — `cell`: the table's PLAN-SAYS sub-line.
  // Same facts, ONE derivation with the panel row so the two surfaces can
  // never disagree. Deductible-phase lines lead with what you pay NOW
  // ("full amount until deductible met, then …"), met lines state the bare
  // rate. Deliberately silent (null) on unpriced/not-covered lines, and never
  // asserts "no deductible" when deductibleApplies is UNKNOWN — that suffix
  // only renders on an explicit false.
  const dedExempt = line.deductibleApplies === false;
  if (line.copay != null && line.copay > 0) {
    const c = fmtMoney(line.copay);
    if (dedUnmet) {
      return {
        term: `$${c} copay after deductible`,
        amountText: owe,
        detail: `Your plan says: covered — a $${c} copay after${dedDollar}. It isn't met, so up to $${fmtMoney(line.shouldOwe)} is yours to pay.${src}`,
        cell: `full amount until deductible met, then $${c} copay`,
      };
    }
    return {
      term: `$${c} copay`,
      amountText: owe,
      detail: `Your plan says: covered with a $${c} copay.${dedMet ? " Your deductible is met." : ""}${src}`,
      cell: dedExempt ? `$${c} copay — no deductible` : `$${c} copay`,
    };
  }
  if (line.coinsurance != null && line.coinsurance > 0) {
    const pct = Math.round(line.coinsurance * 100);
    if (dedUnmet) {
      return {
        term: `${pct}% after deductible`,
        amountText: owe,
        detail: `Your plan says: covered — ${pct}% after${dedDollar}. It isn't met, so up to $${fmtMoney(line.shouldOwe)} is yours to pay.${src}`,
        cell: `full amount until deductible met, then ${pct}%`,
      };
    }
    return {
      term: `${pct}% coinsurance`,
      amountText: owe,
      detail: `Your plan says: covered — you pay ${pct}% of the allowed amount.${dedMet ? " Your deductible is met." : ""}${src}`,
      cell: dedExempt ? `${pct}% coinsurance — no deductible` : `${pct}% coinsurance`,
    };
  }
  // Explicit $0 (copay 0, or coinsurance 0): the approved visit wording. In
  // the deductible phase ("no charge after deductible" plans) the cell still
  // leads with what you pay NOW.
  return {
    term: "no copay",
    amountText: owe,
    detail: `Your plan says: covered, no copay — you owe $0.${src}`,
    cell: dedUnmet ? "full amount until deductible met, then no charge" : "no copay",
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildSavingsDerivation(args: {
  lines: DerivationLineInput[];
  /** recovery.provenance.citationSource === "claim_header" (header-prorated amounts). */
  prorated: boolean;
  /** Claim-level: what the user has paid OOP. */
  paidTotal: number;
  /** Claim-level: the balance the bill still claims (stillOutstanding). */
  balanceTotal: number;
  refundComponent: number;
  forgivenessComponent: number;
  /**
   * S309 F17 — what the bill actually CHARGED the patient (effective patient
   * responsibility, override-independent). Splits the refund into the
   * insurer-claimable slice (capped at charge − share) and the paid-above-
   * charge slice the PROVIDER owes back. Optional with the honest fallback
   * paid + balance — the charge identity for every non-overpaid bill —
   * so untouched callers are byte-identical.
   */
  chargedTotal?: number;
}): SavingsDerivation {
  const charged = args.lines.filter((l) => l.billed > 0);
  const priced = charged.filter((l) => l.rateKnown);
  const pricedShouldOwe = round2(priced.reduce((s, l) => s + l.shouldOwe, 0));

  const rows: DerivationRow[] = charged.map((l) => {
    const { term, amountText, detail, cell } = planAnswerFor(l);
    // A line the user paid speaks in refunds; an unpaid line in balance relief.
    const paidLabel: DerivationRow["paidLabel"] =
      l.paid < 1 && l.stillBilled >= 1 ? "Still billed" : "You paid";
    const paidAmount = paidLabel === "Still billed" ? l.stillBilled : l.paid;
    // Refund outranks forgiveness when a line somehow carries both ≥ $1 (the
    // card totals still show both; the row names the money already out of
    // pocket first).
    const result: DerivationRow["result"] =
      l.refund >= 1
        ? { kind: "owed_back", amount: l.refund }
        : l.forgiveness >= 1
          ? { kind: "off_balance", amount: l.forgiveness }
          : { kind: "none", amount: 0 };
    return {
      id: l.id,
      label: l.label,
      planTerm: term,
      planTermCell: cell,
      planAmountText: amountText,
      unpriced: !l.rateKnown,
      planDetail: detail,
      paidLabel,
      paidAmount,
      result,
      resultLabel:
        result.kind === "owed_back" ? "You're Owed" : result.kind === "off_balance" ? "Off your balance" : null,
      resultNone:
        result.kind !== "none"
          ? null
          : l.rateKnown && l.deductibleApplies === true && l.deductibleMet === false
            ? "counts toward your deductible"
            : "nothing provable yet",
      cta: !l.rateKnown && !!l.serviceSlug,
    };
  });

  const allPriced = priced.length === charged.length && charged.length > 0;

  // The bill-card state model (v7 mock rules). Refund lives in the paid split,
  // forgiveness in the balance split; a single split carries its companion's
  // $0.00 row so it tells the whole story alone; recovery < $1 → no splits at
  // all (there is no recovery story, and the card keeps today's headline).
  const recovery = args.refundComponent + args.forgivenessComponent;
  const recoveryHeadline = recovery >= 1;
  // S309 F17 (Andrew's design) — paid-above-charge is the PROVIDER's refund,
  // not the insurer-claimable one: split the refund at the charge line so the
  // panel's refund row equals what the insurer letter claims and the overpaid
  // row equals what the provider letter claims — three surfaces, two
  // derivations, agreement by construction. chargedTotal falls back to
  // paid + balance (the charge identity when nobody overpaid) → byte-identical
  // for untouched callers.
  const chargedTotal = args.chargedTotal ?? round2(args.paidTotal + args.balanceTotal);
  const overpaidToProvider = round2(Math.max(0, args.paidTotal - chargedTotal));
  const refundCapped = round2(Math.max(0, args.refundComponent - overpaidToProvider));
  const paidSplitOn = recoveryHeadline && args.paidTotal >= 1 && args.refundComponent >= 1;
  const balanceSplitOn = recoveryHeadline && args.balanceTotal >= 1 && args.forgivenessComponent >= 1;
  const yours = round2(args.paidTotal - args.refundComponent);
  const legit = round2(args.balanceTotal - args.forgivenessComponent);
  const bill: BillCardModel = {
    recoveryHeadline,
    chargedToYou: chargedTotal,
    paidSplit: paidSplitOn
      ? {
          divider: `Where your $${fmtMoney(args.paidTotal)} went`,
          yours,
          refund: refundCapped,
          overpaid: overpaidToProvider,
          forgivenessZero: !balanceSplitOn,
          equation:
            overpaidToProvider >= 1
              ? `$${fmtMoney(yours)} + $${fmtMoney(refundCapped)} + $${fmtMoney(overpaidToProvider)} = the $${fmtMoney(args.paidTotal)} you paid ✓`
              : `$${fmtMoney(yours)} + $${fmtMoney(refundCapped)} = the $${fmtMoney(args.paidTotal)} you paid ✓`,
        }
      : null,
    balanceSplit: balanceSplitOn
      ? {
          divider: `Where the $${fmtMoney(args.balanceTotal)} balance stands`,
          legit,
          forgiveness: args.forgivenessComponent,
          refundZero: !paidSplitOn,
          equation: `$${fmtMoney(legit)} + $${fmtMoney(args.forgivenessComponent)} = the $${fmtMoney(args.balanceTotal)} balance ✓`,
        }
      : null,
  };

  const spreadTotal = args.paidTotal >= 1 ? args.paidTotal : args.balanceTotal;

  return {
    rows,
    chargedCount: charged.length,
    pricedCount: priced.length,
    pricedShouldOwe,
    bigLabel: allPriced ? "owed based on your plan" : "owed based on your plan, so far",
    // ≥2 terms (a one-term "equation" proves nothing) and ≤3 (readability).
    planPill:
      allPriced && charged.length >= 2 && charged.length <= 3
        ? `${charged.map((l) => `$${fmtMoney(l.shouldOwe)}`).join(" + ")} = the $${fmtMoney(pricedShouldOwe)} owed ✓`
        : null,
    bill,
    spreadSentence: args.prorated
      ? `Your bill reports payments only as one total, so we split $${fmtMoney(spreadTotal)} across the charged lines by their share of the bill.`
      : null,
    // S309 F17 — the hero sub names the INSURER-claimable slice (the letter's
    // number); the overpaid slice carries its own panel row + provider letter.
    refundSub: refundCapped >= 1 ? `+$${fmtMoney(refundCapped)} refund to request` : null,
    forgivenessSub:
      args.forgivenessComponent >= 1
        ? `$${fmtMoney(args.forgivenessComponent)} to remove from your balance`
        : null,
  };
}
