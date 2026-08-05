/**
 * S304 — blast-radius measurement for the per-line totals defect (tracker Item AD).
 *
 * Read-only. For every DEV claim, classifies EACH of the four adjudicated fields
 * as one of:
 *
 *   AGREES      — per-line sum matches the header within $0.01 (cite-grade)
 *   ABSENT      — the header carries a value but NO line carries one at all
 *                 (a header-only bill: the parser was RIGHT to emit null per the
 *                 PR4b/S143-v3 table-structure rule — this is not a disagreement)
 *   ZERO_ONLY   — every line reads exactly 0 while the header is non-zero.
 *                 Indistinguishable from ABSENT in stored data for the two fields
 *                 persist.ts coerces (`?? 0`) — that coercion is the defect.
 *   CONTRADICTS — at least one line carries a real non-zero value and the sum
 *                 still disagrees with the header (a genuine parse conflict)
 *   NO_HEADER   — header null; nothing to compare against
 *
 * The S302 adjudication question fires whenever |sum − header| > 0.01, which
 * lumps ABSENT + ZERO_ONLY + CONTRADICTS together. This script splits them.
 *
 * Usage: npx tsx scripts/s304-totals-blast-radius.ts
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

type Verdict = "AGREES" | "ABSENT" | "ZERO_ONLY" | "CONTRADICTS" | "NO_HEADER";

const FIELDS = [
  { label: "patient_owes", headerCol: "total_patient_responsibility", lineCol: "patient_owes", coercedByPersist: false },
  { label: "patient_paid", headerCol: "total_patient_paid", lineCol: "patient_paid_amount", coercedByPersist: true },
  { label: "insurance_paid", headerCol: "total_insurance_paid", lineCol: "insurance_paid", coercedByPersist: false },
  { label: "ins_adjusted", headerCol: "total_insurance_adjusted", lineCol: "insurance_adjusted_amount", coercedByPersist: true },
] as const;

function classify(
  header: number | null,
  lineVals: Array<number | null>,
): { verdict: Verdict; sum: number } {
  const sum = lineVals.reduce<number>((s, v) => s + (v != null ? Number(v) : 0), 0);
  if (header == null) return { verdict: "NO_HEADER", sum };
  if (Math.abs(sum - header) <= 0.01) return { verdict: "AGREES", sum };
  const anyNonNull = lineVals.some((v) => v != null);
  if (!anyNonNull) return { verdict: "ABSENT", sum };
  const anyNonZero = lineVals.some((v) => v != null && Number(v) !== 0);
  if (!anyNonZero) return { verdict: "ZERO_ONLY", sum };
  return { verdict: "CONTRADICTS", sum };
}

async function main() {
  console.log(`Project: ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`);

  const claims = await sb
    .from("claims")
    .select(
      "id, date_of_service, total_billed, total_patient_responsibility, total_patient_paid, total_insurance_paid, total_insurance_adjusted, metadata, deleted_at",
    )
    .is("deleted_at", null);
  if (claims.error) throw new Error(`claims: ${claims.error.message}`);

  const lines = await sb
    .from("claim_line_items")
    .select("claim_id, line_number, billed_amount, patient_owes, patient_paid_amount, insurance_paid, insurance_adjusted_amount");
  if (lines.error) throw new Error(`claim_line_items: ${lines.error.message}`);

  const byClaim = new Map<string, Array<Record<string, unknown>>>();
  for (const l of lines.data as Array<Record<string, unknown>>) {
    const k = l.claim_id as string;
    if (!byClaim.has(k)) byClaim.set(k, []);
    byClaim.get(k)!.push(l);
  }

  const tally: Record<string, Record<Verdict, number>> = {};
  for (const f of FIELDS) {
    tally[f.label] = { AGREES: 0, ABSENT: 0, ZERO_ONLY: 0, CONTRADICTS: 0, NO_HEADER: 0 };
  }

  // Claim-level: does the S302 question fire at all (any field over tolerance)?
  let questionFires = 0;
  let firesOnlyBecauseAbsentOrZero = 0;
  let firesWithARealContradiction = 0;
  const rows: string[] = [];

  for (const c of claims.data as Array<Record<string, unknown>>) {
    const ls = byClaim.get(c.id as string) ?? [];
    const perField: string[] = [];
    let anyFire = false;
    let anyContradiction = false;

    for (const f of FIELDS) {
      const header = c[f.headerCol] != null ? Number(c[f.headerCol]) : null;
      const vals = ls.map((l) => (l[f.lineCol] != null ? Number(l[f.lineCol]) : null));
      const { verdict, sum } = classify(header, vals);
      tally[f.label][verdict] += 1;
      if (verdict === "ABSENT" || verdict === "ZERO_ONLY" || verdict === "CONTRADICTS") {
        anyFire = true;
        if (verdict === "CONTRADICTS") anyContradiction = true;
        perField.push(`${f.label}=${verdict}(sum ${sum.toFixed(2)} vs hdr ${header?.toFixed(2)})`);
      }
    }

    if (anyFire) {
      questionFires += 1;
      if (anyContradiction) firesWithARealContradiction += 1;
      else firesOnlyBecauseAbsentOrZero += 1;
      const answered = ((c.metadata as Record<string, unknown> | null)?.userTotalsSource as string) ?? "—";
      rows.push(
        `  ${(c.id as string).slice(0, 8)}  ${String(c.date_of_service ?? "?")}  lines=${ls.length}  answered=${answered}\n      ${perField.join("\n      ")}`,
      );
    }
  }

  console.log(`Claims (not deleted): ${claims.data.length}`);
  console.log(`Line items:           ${lines.data.length}\n`);

  console.log("PER-FIELD VERDICTS (one per claim per field)");
  console.log("field            AGREES  ABSENT  ZERO_ONLY  CONTRADICTS  NO_HEADER   persist ?? 0");
  for (const f of FIELDS) {
    const t = tally[f.label];
    console.log(
      `${f.label.padEnd(15)} ${String(t.AGREES).padStart(6)} ${String(t.ABSENT).padStart(7)} ${String(t.ZERO_ONLY).padStart(10)} ${String(t.CONTRADICTS).padStart(12)} ${String(t.NO_HEADER).padStart(11)}   ${f.coercedByPersist ? "YES" : "no"}`,
    );
  }

  console.log(`\nS302 ADJUDICATION QUESTION`);
  console.log(`  fires on:                                 ${questionFires} / ${claims.data.length} claims`);
  console.log(`  …of which have a REAL contradiction:      ${firesWithARealContradiction}`);
  console.log(`  …of which are ONLY absent/zero-only:      ${firesOnlyBecauseAbsentOrZero}  <- asks the user to adjudicate a bill that has no per-line breakdown`);

  console.log(`\nCLAIMS WHERE IT FIRES\n${rows.join("\n")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
