/**
 * S304 — parse-path smoke. Does the write side actually run?
 *
 * The fixtures prove each new function in isolation. They cannot prove the
 * function is WIRED IN: `applySingleLineHeaderIdentity` runs inside
 * `finalizeParsedBill` at the exit of `parseBillWithHaiku`, and persist's changes
 * run only on a fresh parse. Until a bill is actually parsed, every one of those
 * is unexecuted code.
 *
 * This re-parses stored OCR through the REAL `parseBillWithHaiku` and runs the
 * REAL verifiers on the result, then prints exactly what persist would write.
 *
 * WRITES NOTHING to claims or claim_line_items. (One unavoidable side effect:
 * `parseBillWithHaiku` records a cost-ledger row per call.)
 *
 * Usage: npx tsx scripts/s304-parse-smoke.ts
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!url.includes("wdpkmgezhvlmaumhwqua")) {
  console.error(`REFUSING: ${url} is not DEV.`);
  process.exit(1);
}

const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/**
 * One bill per shape the change targets:
 *   9a78cffd — ONE line, header-only adjudication → the single-line identity
 *   e23817b6 — SEVEN lines + a "Provider adjusted: -$7.00" → the identity must
 *              NOT fire, and total_provider_adjusted must survive to persist
 */
const CASES = [
  { claim: "9a78cffd-3d33-4575-acc9-d74d922061c7", note: "1 line · header-only · identity SHOULD fire" },
  { claim: "e23817b6", note: "7 lines · provider adjusted $7.00 · identity must NOT fire" },
  { claim: "6f7682dc", note: "4 lines · the bill is $33.85 short · unallocated_balance SHOULD fire" },
];

function money(v: unknown): string {
  return v == null ? "—" : `$${Number(v).toFixed(2)}`;
}

async function main() {
  const { parseBillWithHaiku } = await import("../src/lib/billing/haiku-bill-parser");
  const { verifyPerLineSums, verifyHeaderReconciliation, loadVerifierTolerances, detectSignViolations } =
    await import("../src/lib/billing/sum-invariants");

  const tolerances = await loadVerifierTolerances();
  console.log(`Project: ${url} (DEV)`);
  console.log(`Tolerances: ${JSON.stringify(tolerances)}\n`);

  const claims = await sb
    .from("claims")
    .select("id, user_id, source_document_id, date_of_service")
    .is("deleted_at", null);
  if (claims.error) throw new Error(claims.error.message);

  for (const c of CASES) {
    const row = (claims.data as Array<Record<string, unknown>>).find((r) =>
      (r.id as string).startsWith(c.claim.slice(0, 8)),
    );
    if (!row) {
      console.log(`SKIP ${c.claim} — no claim`);
      continue;
    }
    const doc = await sb
      .from("documents")
      .select("id, file_name, doc_type, classified_type, processing_ocr_text")
      .eq("id", row.source_document_id as string)
      .single();
    if (doc.error || !doc.data.processing_ocr_text) {
      console.log(`SKIP ${c.claim} — no OCR (${doc.error?.message ?? "empty"})`);
      continue;
    }

    console.log("=".repeat(78));
    console.log(`${(row.id as string).slice(0, 8)}  ${doc.data.file_name}  — ${c.note}`);
    console.log("=".repeat(78));

    const billType = (doc.data.classified_type ?? doc.data.doc_type) === "eob" ? "eob" : "itemized_bill";
    const parsed = await parseBillWithHaiku(
      doc.data.processing_ocr_text as string,
      doc.data.id as string,
      row.user_id as string,
      billType,
    );
    if (!parsed) {
      console.log("  PARSE RETURNED NULL\n");
      continue;
    }

    console.log(`  lines: ${parsed.lineItems.length}   parserPath: ${(parsed as { parserPath?: string }).parserPath}`);
    console.log("  PER LINE (what the parser emitted, AFTER finalizeParsedBill):");
    console.log("    #  billed     allowed    owes       paid       insPaid    insAdj     provAdj");
    for (const li of parsed.lineItems) {
      console.log(
        `    ${String(li.lineNumber).padEnd(2)} ${money(li.billedAmount).padEnd(10)} ${money(li.allowedAmount).padEnd(10)} ` +
          `${money(li.patientResponsibility).padEnd(10)} ${money(li.patient_paid).padEnd(10)} ` +
          `${money(li.insurancePaid).padEnd(10)} ${money(li.ins_adjusted).padEnd(10)} ${money(li.provider_adjusted)}`,
      );
    }
    const t = parsed.totals;
    console.log("  TOTALS:");
    console.log(
      `    billed ${money(t.totalBilled)}  allowed ${money(t.totalAllowed)}  owes ${money(t.totalPatientResponsibility)}  ` +
        `paid ${money(t.totalPatientPaid)}  insPaid ${money(t.totalInsurancePaid)}  insAdj ${money(t.totalInsAdjusted)}  ` +
        `provAdj ${money(t.totalProviderAdjusted)}  contractDisc ${money(t.totalContractDiscount)}  denied ${money(t.totalDenied)}`,
    );

    // The real verifiers, exactly as persist calls them.
    const signs = detectSignViolations(parsed);
    const perLine = verifyPerLineSums(parsed, tolerances);
    const header = verifyHeaderReconciliation(parsed, tolerances);

    console.log("  B-1 per-line sums:");
    for (const v of perLine) {
      console.log(
        `    ${v.field.padEnd(26)} populated=${String(v.populated).padEnd(5)} droppable=${String(v.droppable).padEnd(5)} ` +
          `sum=${money(v.lineSum)} header=${money(v.header)} delta=${Number.isFinite(v.delta) ? v.delta.toFixed(4) : "n/a"} within=${v.withinTolerance}`,
      );
    }
    console.log(
      `  B-2 identity: allPresent=${header.allHeaderTotalsPresent} delta=${Number.isFinite(header.delta) ? header.delta.toFixed(4) : "n/a"} tol=${header.tolerance.toFixed(2)} within=${header.withinTolerance}`,
    );
    console.log(`  B-3 sign violations: ${signs.length}`);

    // What persist would do with all that — the flags and the metadata block.
    const drop = new Set(perLine.filter((v) => v.populated && !v.withinTolerance && v.droppable).map((v) => v.perLineKey));
    const billed = perLine.find((v) => v.perLineKey === "billedAmount");
    const flags: string[] = [];
    if (signs.length) flags.push("bill_parser_sign_violation");
    if (drop.size) flags.push("per_line_breakdown_sparse");
    if (billed && billed.populated && !billed.withinTolerance) flags.push("billed_sum_mismatch");
    if (header.allHeaderTotalsPresent && !header.withinTolerance) flags.push("header_reconciliation_failed");

    const extra: Record<string, number> = {};
    if (t.totalProviderAdjusted != null) extra.total_provider_adjusted = Math.abs(t.totalProviderAdjusted);
    if (t.totalContractDiscount != null) extra.total_contract_discount = Math.abs(t.totalContractDiscount);
    if (t.totalDenied != null) extra.total_denied = t.totalDenied;

    // The audit rule, exactly as runAudit calls it — does the document's own
    // arithmetic gap reach the user as a finding?
    const { runClaimHeaderArithmeticCheck, IDENTITY_BENCHMARK_SOURCE } = await import(
      "../src/lib/audit/claim-header-arithmetic"
    );
    const findings = await runClaimHeaderArithmeticCheck(parsed);
    console.log(`  AUDIT — unallocated balance: ${findings.length === 0 ? "(no finding)" : ""}`);
    for (const f of findings) {
      console.log(`    ${f.title}   [${f.benchmarkSource}]  severity=${f.severity}  actionable=${f.actionable}`);
      console.log(`    "${f.description}"`);
    }
    const identityFinding = findings.some((f) => f.benchmarkSource === IDENTITY_BENCHMARK_SOURCE);

    // The REAL verdict + notifier path — this is what pages Slack and queues the
    // bill for admin review, and it derives the condition separately from the
    // claim flag. Proving both, not just the flag.
    const { computeVerdict } = await import("../src/lib/billing/bill-parser-decisions");
    const { shouldNotify } = await import("../src/lib/billing/bill-parser-slack");
    const v = computeVerdict(signs, perLine, header, identityFinding);
    console.log(`  DECISION ROW: verdict=${v.verdict} categories=[${v.categories.join(",")}]  → Slack alert: ${shouldNotify(v.verdict) ? "YES" : "no"}`);

    console.log(`  PERSIST WOULD WRITE:`);
    if (identityFinding) {
      const i = flags.indexOf("header_reconciliation_failed");
      if (i > -1) {
        flags.splice(i, 1);
        console.log(`    header_reconciliation_failed SUPPRESSED — the document is at fault, not our reading`);
      }
    }
    console.log(`    verdict flags: ${flags.length ? flags.join(", ") : "(none — clean)"}`);
    console.log(`    dropped to null: ${drop.size ? [...drop].join(", ") : "(none)"}`);
    console.log(`    metadata.parsedTotals: ${Object.keys(extra).length ? JSON.stringify(extra) : "(omitted)"}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
