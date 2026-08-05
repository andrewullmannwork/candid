// S304 — the single-line header identity.
//
// A bill states its adjudication either PER LINE (an EOB's columns) or ONCE for
// the whole bill (a provider itemised receipt's summary block). We modelled only
// the first and treated the second as a broken version of it — comparing a header
// figure against the sum of per-line values that were never printed, and calling
// the difference a disagreement for the user to settle.
//
// When a bill carries EXACTLY ONE line item those two statements are the same
// statement: the header total for a field IS that line's value, because there is
// nothing to allocate it across. That is an IDENTITY, not an estimate — unlike
// the read-time proration in `effective-totals.ts`, which spreads a header total
// across many lines by charge share and is honestly labelled `header_prorated`.
// Multi-line bills are deliberately untouched here: those figures genuinely are
// not stated per line, and no rule can invent them.
//
// Applied once, at the exit of `parseBillWithHaiku`, which is the single point
// all three ingest paths pass through — so every consumer of the ParsedBill
// (runAudit, the B-1/B-2/B-3 verifiers, persistAuditResults, collectPricingData)
// sees the same object with no wiring of its own.
//
// Pure: types only, no DB, no flags — same shape as `line-plausibility.ts`.

import type { ParsedBill } from "./types";

/**
 * Header total ↔ per-line field. Every pair the parser can emit at BOTH levels
 * is listed, so a new field is one entry rather than a new branch.
 *
 * `totalBilled` is deliberately ABSENT: billed is required per line and always
 * populated, and the B-1 billed reconciliation checks the line sum against the
 * header. Filling it from the header would make that check assert nothing.
 */
const IDENTITY_PAIRS: ReadonlyArray<{
  total: keyof ParsedBill["totals"];
  line: keyof import("./types").BillLineItem;
}> = [
  { total: "totalAllowed", line: "allowedAmount" },
  { total: "totalInsurancePaid", line: "insurancePaid" },
  { total: "totalPatientResponsibility", line: "patientResponsibility" },
  { total: "totalPatientPaid", line: "patient_paid" },
  { total: "totalInsAdjusted", line: "ins_adjusted" },
  { total: "totalProviderAdjusted", line: "provider_adjusted" },
  { total: "totalDenied", line: "denied_amount" },
  { total: "totalContractDiscount", line: "contract_discount" },
];

export interface HeaderIdentityResult {
  /** Per-line field names filled from the header. Empty when the rule did not apply. */
  filled: string[];
}

/**
 * Fill a single-line bill's per-line values from its header totals, IN PLACE.
 *
 * No-op unless the bill has exactly one line item. Never overwrites a value the
 * parser already read off the line — so a genuine per-line/header contradiction
 * on a one-line bill still surfaces as a conflict for the user to settle, rather
 * than being silently papered over.
 */
export function applySingleLineHeaderIdentity(bill: ParsedBill): HeaderIdentityResult {
  if (bill.lineItems.length !== 1) return { filled: [] };

  const line = bill.lineItems[0] as unknown as Record<string, unknown>;
  const totals = bill.totals as unknown as Record<string, unknown>;
  const filled: string[] = [];

  for (const pair of IDENTITY_PAIRS) {
    const headerValue = totals[pair.total];
    if (typeof headerValue !== "number" || !Number.isFinite(headerValue)) continue;
    // Observed on the line already — the line wins, and any disagreement stays
    // visible instead of being overwritten.
    if (line[pair.line] != null) continue;
    line[pair.line] = headerValue;
    filled.push(pair.line as string);
  }

  return { filled };
}
