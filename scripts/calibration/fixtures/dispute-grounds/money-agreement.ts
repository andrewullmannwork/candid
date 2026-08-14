/**
 * money-agreement — S314. Locks the arithmetic RELATIONSHIPS between the
 * surfaces that show a user a dollar figure.
 *
 * WHY RELATIONSHIPS AND NOT LITERALS. Every assertion here compares two things
 * the product computes, rather than comparing one of them to a number I typed.
 * That is deliberate: the S313 retrospective's standing lesson is that my
 * fixture assertions were "wrong three commits running — always written from
 * what I expected the letter to say rather than what it contains." An assertion
 * of the form "the header equals the sum of the bullets" cannot be wrong about
 * my expectations. It can only be wrong about the code, which is the point.
 *
 * THE DEFECT THIS WOULD HAVE CAUGHT (Andrew, from a PROD letter paste):
 *
 *   Total Disputed: $33.25          ← header, from evidence.totals
 *   ...body...      $33.25 + $39.12 + $14.88 = $87.25
 *
 * `totalDiscrepancy` was a running tally accumulated during the FIRST coverage
 * pass. A second pass (`secondary_coverage_v2`) then matched more lines by
 * category and MUTATED their `discrepancyAmount` — after the tally was final.
 * The body reads the mutated line evidence; the header read the stale tally.
 * Immunizations and preventive care are exactly the class that resolves by
 * category, so this understated a large family of letters, not a corner case.
 *
 * THE THREE INVARIANTS
 *
 *   1. TOTALS FOLLOW THE LINES — evidence.totals is a projection of the line
 *      evidence, evaluated after every pass. Any future pass that writes to a
 *      line is included automatically; a tally would have to be remembered.
 *
 *   2. PROJECTIONS NEVER REACH THE DEMAND — an unconfirmed category match
 *      carries a `projectedDiscrepancy` on its ASK so the panel can say what
 *      answering is worth. It must never appear on the line, because the line
 *      is what the total sums, and the total is what the letter demands. This
 *      asserts the leak is closed.
 *
 *   3. THE CEILING RECONCILES TO THE DEMAND — the claim page promises what the
 *      plan says you could recover; the letter demands only what it can cite
 *      today. The difference must equal what is sitting behind unanswered
 *      confirmations. Not zero — attributable. This is what stops the two
 *      surfaces drifting into an unexplained gap ($131.21 vs $87.25).
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/money-agreement.ts
 */
import {
  sumEvidenceTotals,
  type ClaimEvidence,
  type LineItemEvidence,
} from "../../../../src/lib/disputes/evidence-resolver";

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean) {
  if (ok) pass++;
  else fails.push(`  ✗ ${name}`);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A line as the resolver leaves it. Only the fields these invariants read are
 * populated; the cast keeps the fixture honest about that rather than
 * pretending to build a full LineItemEvidence.
 */
function line(opts: {
  id: string;
  billed: number;
  discrepancy: number | null;
  /** An unconfirmed category match: the ASK carries a projection, the line does not. */
  projected?: number | null;
}): LineItemEvidence {
  return {
    lineItemId: opts.id,
    billedAmount: opts.billed,
    discrepancyAmount: opts.discrepancy,
    ...(opts.projected != null
      ? {
          secondaryCoverageVerify: {
            matchedSlug: "preventive_care",
            matchedServiceName: "preventive care (ACA $0)",
            costShareLabel: "no cost to you",
            projectedDiscrepancy: opts.projected,
          },
        }
      : {}),
  } as unknown as LineItemEvidence;
}

function claim(lines: LineItemEvidence[]): ClaimEvidence {
  return { lineItemEvidence: lines } as unknown as ClaimEvidence;
}

// ── 1 · TOTALS FOLLOW THE LINES ────────────────────────────────────────────
// The exact shape of Andrew's PROD letter: one line resolved by exact slug in
// pass 1, two resolved by category in pass 2. The old tally saw only the first.
{
  const exactMatch = line({ id: "l1", billed: 428, discrepancy: 33.25 });
  const category1 = line({ id: "l3", billed: 347, discrepancy: 39.12 });
  const category2 = line({ id: "l7", billed: 132, discrepancy: 14.88 });
  const claims = [claim([exactMatch, category1, category2])];

  const totals = sumEvidenceTotals(claims);
  const bodySum = round2(
    claims.flatMap((c) => c.lineItemEvidence).reduce((s, li) => s + (li.discrepancyAmount ?? 0), 0),
  );

  check(
    "header total equals the sum of the per-line amounts the body prints",
    round2(totals.totalDiscrepancy) === bodySum,
  );
  check("the PROD case reconciles: 33.25 + 39.12 + 14.88", round2(totals.totalDiscrepancy) === 87.25);
  check("billed follows the lines too", round2(totals.totalBilled) === 907);
}

// The regression itself: MUTATE a line the way pass 2 does, and re-derive. A
// tally computed before the mutation cannot see this; a projection must.
{
  const mutable = line({ id: "l1", billed: 100, discrepancy: 10 });
  const claims = [claim([mutable, line({ id: "l2", billed: 200, discrepancy: null })])];
  const before = sumEvidenceTotals(claims).totalDiscrepancy;

  // pass 2 resolves the second line by category and writes its discrepancy
  claims[0].lineItemEvidence[1].discrepancyAmount = 25;
  const after = sumEvidenceTotals(claims).totalDiscrepancy;

  check("a pass that writes to a line moves the total", round2(before) === 10 && round2(after) === 35);
}

{
  check("no claims → zero, not NaN", sumEvidenceTotals([]).totalDiscrepancy === 0);
  check(
    "a claim with no lines → zero, not NaN",
    sumEvidenceTotals([claim([])]).totalBilled === 0,
  );
}

// ── 2 · PROJECTIONS NEVER REACH THE DEMAND ─────────────────────────────────
// The unconfirmed line is worth $43.96 IF the user confirms the match. Until
// then the letter must not demand it, which means the total must not see it.
{
  const confirmed = line({ id: "l1", billed: 428, discrepancy: 33.25 });
  const unconfirmed = line({ id: "l2", billed: 390, discrepancy: null, projected: 43.96 });
  const claims = [claim([confirmed, unconfirmed])];
  const totals = sumEvidenceTotals(claims);

  check(
    "an unconfirmed match's projection stays OUT of the demand",
    round2(totals.totalDiscrepancy) === 33.25,
  );
  check(
    "the projection is on the ASK, where the panel can price the question",
    unconfirmed.secondaryCoverageVerify?.projectedDiscrepancy === 43.96,
  );
  check(
    "an unconfirmed match carries no line-level discrepancy",
    unconfirmed.discrepancyAmount == null,
  );
}

// ── 3 · THE CEILING RECONCILES TO THE DEMAND ───────────────────────────────
// ceiling − demand must equal the open projections. Andrew's bill exactly:
// the claim page promised $131.21, the letter demanded $87.25, and the $43.96
// between them was one unanswered coverage question nothing on screen named.
{
  const claims = [
    claim([
      line({ id: "l1", billed: 428, discrepancy: 33.25 }),
      line({ id: "l2", billed: 390, discrepancy: null, projected: 43.96 }),
      line({ id: "l3", billed: 347, discrepancy: 39.12 }),
      line({ id: "l7", billed: 132, discrepancy: 14.88 }),
    ]),
  ];
  const demand = round2(sumEvidenceTotals(claims).totalDiscrepancy);
  const openProjections = round2(
    claims
      .flatMap((c) => c.lineItemEvidence)
      .reduce((s, li) => s + (li.secondaryCoverageVerify?.projectedDiscrepancy ?? 0), 0),
  );
  const ceiling = round2(demand + openProjections);

  check("the letter demands only what it can cite", demand === 87.25);
  check("the gap is exactly the open confirmations", openProjections === 43.96);
  check("ceiling = demand + open questions (131.21)", ceiling === 131.21);
  check(
    "with nothing open, ceiling and demand agree",
    (() => {
      const settled = [claim([line({ id: "l1", billed: 428, discrepancy: 33.25 })])];
      const d = round2(sumEvidenceTotals(settled).totalDiscrepancy);
      const p = settled
        .flatMap((c) => c.lineItemEvidence)
        .reduce((s, li) => s + (li.secondaryCoverageVerify?.projectedDiscrepancy ?? 0), 0);
      return d === 33.25 && p === 0;
    })(),
  );
}

console.log(`\nmoney-agreement fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
