/**
 * S304 — clear the fabricated zeros from legacy claim_line_items rows.
 *
 * WHAT WENT WRONG
 * ---------------
 * Until this session `persist.ts` coerced the parser's `null` to `0` on two
 * columns:
 *
 *   insurance_adjusted_amount: dropInsAdjusted ? null : absOrNull(...) ?? 0
 *   patient_paid_amount:       dropPatientPaid ? null : absOrNull(...) ?? 0
 *
 * PR4b/S143 v3 had hardened the prompt so `null` means "this bill does not state
 * the field per line" — a provider itemised receipt prints its adjustments once,
 * in the summary block. The `?? 0` erased that distinction two statements after
 * the B-1 verifier computed it, writing a zero the page never printed onto every
 * line. The read layer then could not tell "absent" from "the lines say zero",
 * so it asked users to settle a conflict that did not exist.
 *
 * WHY THE PREDICATE IS EXACT, NOT A GUESS
 * ---------------------------------------
 * Target: every line of a claim reads exactly 0 for a field whose claim-header
 * total is NON-ZERO. That state can ONLY have come from the `?? 0`, because:
 *
 *   - had the parser emitted real zeros on all lines, `verifyPerLineSums` would
 *     have marked the field populated with a delta far outside tolerance →
 *     `perLineDropFields` would contain it → persist would have written NULL.
 *   - had the parser emitted real values, they would sum toward the header and
 *     at least one line would be non-zero.
 *
 * A mixed claim (some lines zero, some populated) is real parser output and is
 * left alone. A claim whose header is also zero is left alone — 0 against 0 is
 * consistent and may be exactly what the bill printed.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not FILL anything. The single-line header identity runs at parse time
 * and only a re-parse applies it to an existing claim; this script only removes
 * values we invented. It also leaves `claims.metadata.userTotalsSource` alone:
 * the `decideField` reorder means agreement now outranks a stored answer, so a
 * stale "summary" answer no longer suppresses anything.
 *
 * Usage:
 *   npx tsx scripts/s304-unfabricate-zeros-backfill.ts            # dry run
 *   npx tsx scripts/s304-unfabricate-zeros-backfill.ts --apply    # write
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;

// Hard DEV guard. `wdpk…` is DEV, `viahl…` is PROD. A backfill aimed at the
// wrong project is not recoverable by re-running it.
const DEV_REF = "wdpkmgezhvlmaumhwqua";
if (!url.includes(DEV_REF)) {
  console.error(`REFUSING: ${url} is not the DEV project (${DEV_REF}).`);
  console.error("Point .env.local at DEV, or edit DEV_REF deliberately for a PROD run.");
  process.exit(1);
}

const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const FIELDS = [
  { line: "insurance_adjusted_amount", header: "total_insurance_adjusted" },
  { line: "patient_paid_amount", header: "total_patient_paid" },
] as const;

async function main() {
  console.log(`Project: ${url}  (DEV)`);
  console.log(APPLY ? "MODE: APPLY — this writes.\n" : "MODE: dry run — nothing is written.\n");

  const claims = await sb
    .from("claims")
    .select("id, date_of_service, total_insurance_adjusted, total_patient_paid")
    .is("deleted_at", null);
  if (claims.error) throw new Error(`claims: ${claims.error.message}`);

  const lines = await sb
    .from("claim_line_items")
    .select("id, claim_id, line_number, insurance_adjusted_amount, patient_paid_amount");
  if (lines.error) throw new Error(`claim_line_items: ${lines.error.message}`);

  const byClaim = new Map<string, Array<Record<string, unknown>>>();
  for (const l of lines.data as Array<Record<string, unknown>>) {
    const k = l.claim_id as string;
    if (!byClaim.has(k)) byClaim.set(k, []);
    byClaim.get(k)!.push(l);
  }

  const toClear: Array<{ id: string; field: string; claim: string; header: number }> = [];
  let claimsTouched = 0;

  for (const c of claims.data as Array<Record<string, unknown>>) {
    const ls = byClaim.get(c.id as string) ?? [];
    if (ls.length === 0) continue;
    let touched = false;

    for (const f of FIELDS) {
      const header = c[f.header] != null ? Number(c[f.header]) : null;
      if (header == null || header === 0) continue; // 0 vs 0 is consistent — leave it
      const allZero = ls.every((l) => l[f.line] != null && Number(l[f.line]) === 0);
      if (!allZero) continue; // real parser output, or already null
      touched = true;
      for (const l of ls) {
        toClear.push({ id: l.id as string, field: f.line, claim: (c.id as string).slice(0, 8), header });
      }
      console.log(
        `  ${(c.id as string).slice(0, 8)}  ${String(c.date_of_service).padEnd(11)} ${f.line.padEnd(26)} ${ls.length} line(s) at $0.00  vs header $${header.toFixed(2)}  → null`,
      );
    }
    if (touched) claimsTouched += 1;
  }

  console.log(
    `\n${toClear.length} line-field value(s) across ${claimsTouched} claim(s) were written by the \`?? 0\` and are being cleared.`,
  );

  if (!APPLY) {
    console.log("\nDry run — re-run with --apply to write.");
    return;
  }
  if (toClear.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Grouped per field so each UPDATE sets exactly one column.
  let written = 0;
  for (const f of FIELDS) {
    const ids = toClear.filter((t) => t.field === f.line).map((t) => t.id);
    if (ids.length === 0) continue;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const res = await sb
        .from("claim_line_items")
        .update({ [f.line]: null })
        .in("id", batch);
      if (res.error) throw new Error(`update ${f.line}: ${res.error.message}`);
      written += batch.length;
    }
    console.log(`  ${f.line}: ${ids.length} row(s) set to null`);
  }
  console.log(`\nWrote ${written} value(s).`);

  // Read back — never trust the write, verify the state.
  const after = await sb
    .from("claim_line_items")
    .select("id, insurance_adjusted_amount, patient_paid_amount")
    .in("id", toClear.map((t) => t.id));
  if (after.error) throw new Error(`verify: ${after.error.message}`);
  const stillSet = (after.data as Array<Record<string, unknown>>).filter((r) =>
    toClear.some((t) => t.id === r.id && r[t.field] != null),
  );
  console.log(
    stillSet.length === 0
      ? "VERIFIED — every targeted value now reads null."
      : `⚠ ${stillSet.length} row(s) did NOT clear.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
