/**
 * Backfill Providence-style bills affected by the Ins-adjusted/Ins-paid
 * parser confusion (F-10) + the missing patient_paid_amount column (F-11).
 *
 * Two test claims are patched with values read directly off the source PDFs:
 *   • ed471aa0-9026-4ea9-aa88-f5779358d06e — Bill 1 (06/02/25, single line 99214)
 *   • a0152246-4077-4f41-ac05-af4022545cf9 — Bill 2 (06/23/25, 4 chargeable lines)
 *
 * Run AFTER mig 092 applies. The script also flips audit_status='stale' on
 * both claims so the next /claim view fires D7 re-audit against the corrected
 * data — exercising F-13 (missing_adjustment now sees adjustments properly)
 * and F-14 (new insurance_underpayment rule).
 *
 * USAGE:
 *   tsx scripts/backfill-providence-bills.ts           # dry run (default)
 *   tsx scripts/backfill-providence-bills.ts --apply   # write to DB
 */

import { createServerClient } from "../src/lib/supabase/server";

const DRY_RUN = !process.argv.includes("--apply");

interface LineUpdate {
  line_number: number;
  billing_code: string;
  insurance_paid: number;
  insurance_adjusted_amount: number;
  patient_paid_amount: number;
}

interface ClaimBackfill {
  claim_id: string;
  notes: string;
  total_insurance_paid: number;
  total_insurance_adjusted: number;
  total_patient_paid: number;
  lines: LineUpdate[];
}

// Allocation note: PDFs don't show per-line ins_adjusted / ins_paid breakdowns;
// the totals box gives only header sums. Per-line values below are allocated
// PROPORTIONAL BY BILLED AMOUNT across the chargeable lines (lines billed $0
// are quality/reporting codes and unaffected). Sums reconcile to the header
// totals within ±$0.05 rounding.
const BACKFILLS: ClaimBackfill[] = [
  {
    claim_id: "ed471aa0-9026-4ea9-aa88-f5779358d06e",
    notes:
      "Bill 1 — Swedish Primary Care Sand Point 06/02/25. Single chargeable line 99214 ($428 billed). Ins adjusted $135.59 (contractual writeoff); Ins paid $0 (insurance paid nothing!); Amount due $292.41; Patient paid $292.41 OOP on Jun 27, 2025. Bill settled.",
    total_insurance_paid: 0,
    total_insurance_adjusted: 135.59,
    total_patient_paid: 292.41,
    lines: [
      {
        line_number: 1,
        billing_code: "99214",
        insurance_paid: 0,
        insurance_adjusted_amount: 135.59,
        patient_paid_amount: 292.41,
      },
    ],
  },
  {
    claim_id: "a0152246-4077-4f41-ac05-af4022545cf9",
    notes:
      "Bill 2 — Swedish Primary Care Sand Point 06/23/25. 4 chargeable lines totaling $1,297. Ins adjusted $639.29, Ins paid $511.50, Amount due $146.21, Patient paid $146.21 OOP on Aug 29, 2025. Bill settled. Per-line ins values proportional by billed share.",
    total_insurance_paid: 511.50,
    total_insurance_adjusted: 639.29,
    total_patient_paid: 146.21,
    lines: [
      { line_number: 1, billing_code: "99214", insurance_paid: 168.79, insurance_adjusted_amount: 210.96, patient_paid_amount: 48.25 },
      { line_number: 2, billing_code: "99395", insurance_paid: 153.81, insurance_adjusted_amount: 192.27, patient_paid_amount: 43.96 },
      { line_number: 3, billing_code: "91320", insurance_paid: 136.85, insurance_adjusted_amount: 171.05, patient_paid_amount: 39.10 },
      { line_number: 4, billing_code: "90480", insurance_paid: 52.05,  insurance_adjusted_amount: 65.01,  patient_paid_amount: 14.90 },
    ],
  },
];

async function main() {
  console.log(`[backfill-providence-bills] DRY_RUN=${DRY_RUN}`);
  const supabase = createServerClient();

  for (const b of BACKFILLS) {
    console.log(`\nclaim ${b.claim_id}`);
    console.log(`  ${b.notes}`);

    // Pull existing claim to sanity-check it exists + load current metadata
    const { data: existing, error: readErr } = await supabase
      .from("claims")
      .select("id, metadata, total_insurance_paid, total_patient_responsibility")
      .eq("id", b.claim_id)
      .maybeSingle();
    if (readErr || !existing) {
      console.warn(`  claim not found in DB; skipping`);
      continue;
    }

    const existingMeta = (existing.metadata as Record<string, unknown> | null) ?? {};
    const newMeta = {
      ...existingMeta,
      audit_status: "stale", // trigger D7 re-audit on next view
      backfill_notes: b.notes,
      backfilled_at: new Date().toISOString(),
    };

    if (!DRY_RUN) {
      const { error } = await supabase
        .from("claims")
        .update({
          total_insurance_paid: b.total_insurance_paid,
          total_insurance_adjusted: b.total_insurance_adjusted,
          total_patient_paid: b.total_patient_paid,
          metadata: newMeta,
        })
        .eq("id", b.claim_id);
      if (error) {
        console.error(`  claim header update failed:`, error);
        continue;
      }
    }
    console.log(
      `  ✓ header: insurance_paid=${b.total_insurance_paid}, insurance_adjusted=${b.total_insurance_adjusted}, patient_paid=${b.total_patient_paid}, audit_status=stale`,
    );

    for (const line of b.lines) {
      if (!DRY_RUN) {
        const { error } = await supabase
          .from("claim_line_items")
          .update({
            insurance_paid: line.insurance_paid,
            insurance_adjusted_amount: line.insurance_adjusted_amount,
            patient_paid_amount: line.patient_paid_amount,
          })
          .eq("claim_id", b.claim_id)
          .eq("line_number", line.line_number)
          .eq("billing_code", line.billing_code);
        if (error) {
          console.error(`    line ${line.line_number} (${line.billing_code}) update failed:`, error);
          continue;
        }
      }
      console.log(
        `    ✓ line ${line.line_number} ${line.billing_code}: ins_paid=${line.insurance_paid}, ins_adjusted=${line.insurance_adjusted_amount}, patient_paid=${line.patient_paid_amount}`,
      );
    }
  }

  console.log(
    `\n${DRY_RUN ? "Dry run complete. Re-run with --apply to write to DB." : "Backfill applied."}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
