/**
 * S304 — the spot-check pack (tracker Item AD).
 *
 * READ-ONLY. Builds the sheet Andrew reads with the actual bills open: for every
 * DEV claim, what the DOCUMENT says next to what WE stored, so a human can judge
 * whether the numbers are right rather than taking the harness's word for it.
 *
 * For each claim it emits:
 *   1. the source document's own summary block, VERBATIM from stored OCR
 *   2. every stored line item's four money fields
 *   3. the claim header totals
 *   4. what the adjudication question currently asks the user
 * and downloads the original PDF/image so the sheet can be checked against the page.
 *
 * ⚠ PII — these are real bills with real patient names. Everything lands in the
 * session scratchpad, never the vault, and is deleted at session close.
 *
 * Usage:
 *   npx tsx scripts/s304-bill-spotcheck.ts --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 ? process.argv[outArg + 1] : "./s304-spotcheck";
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "bills"), { recursive: true });

/**
 * Pull the adjudication/summary block out of the OCR. Bills state their totals in
 * a labelled block; we surface every line carrying one of those labels plus its
 * neighbours, so the reader sees the block in context rather than a grep hit.
 */
const TOTAL_LABELS =
  /(total\s+billed|total\s+charge|amount\s+due|total\s+due|ins(urance)?\s+adjust|ins(urance)?\s+paid|plan\s+paid|patient\s+(owes|responsibility|paid)|you\s+(paid|owe)|balance|adjustment|cost\s+reduction|contract\s+discount|allowed|deductible|copay|coinsurance|write.?off)/i;

function summaryBlock(ocr: string): string {
  const lines = ocr.split(/\r?\n/);
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (TOTAL_LABELS.test(l)) {
      for (let d = -1; d <= 2; d++) if (i + d >= 0 && i + d < lines.length) keep.add(i + d);
    }
  });
  if (keep.size === 0) return "(no labelled totals block found in OCR)";
  const idx = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -99;
  for (const i of idx) {
    if (i - prev > 1) out.push("      …");
    out.push(`      ${lines[i]}`);
    prev = i;
  }
  return out.join("\n");
}

function money(v: unknown): string {
  return v == null ? "—" : `$${Number(v).toFixed(2)}`;
}

async function main() {
  const claims = await sb
    .from("claims")
    .select(
      "id, date_of_service, source_document_id, total_billed, total_patient_responsibility, total_patient_paid, total_insurance_paid, total_insurance_adjusted, metadata",
    )
    .is("deleted_at", null)
    .order("date_of_service", { ascending: true });
  if (claims.error) throw new Error(`claims: ${claims.error.message}`);

  const lines = await sb
    .from("claim_line_items")
    .select("claim_id, line_number, description, billing_code, billed_amount, patient_owes, patient_paid_amount, insurance_paid, insurance_adjusted_amount")
    .order("line_number", { ascending: true });
  if (lines.error) throw new Error(`claim_line_items: ${lines.error.message}`);

  const byClaim = new Map<string, Array<Record<string, unknown>>>();
  for (const l of lines.data as Array<Record<string, unknown>>) {
    const k = l.claim_id as string;
    if (!byClaim.has(k)) byClaim.set(k, []);
    byClaim.get(k)!.push(l);
  }

  const docIds = (claims.data as Array<Record<string, unknown>>)
    .map((c) => c.source_document_id as string | null)
    .filter((x): x is string => !!x);
  const docs = await sb
    .from("documents")
    .select("id, file_name, storage_path, classified_type, doc_type, processing_ocr_text")
    .in("id", docIds);
  if (docs.error) throw new Error(`documents: ${docs.error.message}`);
  const docById = new Map(
    (docs.data as Array<Record<string, unknown>>).map((d) => [d.id as string, d]),
  );

  const report: string[] = [];
  const downloaded: string[] = [];
  const missing: string[] = [];

  report.push("S304 — BILL SPOT-CHECK PACK");
  report.push("Read each claim against the PDF of the same name in ./bills/.");
  report.push("⚠ Real patient data — scratchpad only, deleted at session close.\n");

  for (const c of claims.data as Array<Record<string, unknown>>) {
    const id = c.id as string;
    const short = id.slice(0, 8);
    const doc = c.source_document_id ? docById.get(c.source_document_id as string) : null;
    const ls = byClaim.get(id) ?? [];

    report.push("=".repeat(78));
    report.push(`CLAIM ${short}   date of service ${c.date_of_service}   ${ls.length} line item(s)`);
    report.push(`document: ${doc ? `${doc.file_name} [${doc.classified_type ?? doc.doc_type}]` : "(none)"}`);
    report.push("");

    report.push("  WHAT THE BILL SAYS (verbatim from the stored OCR of the document):");
    report.push(doc?.processing_ocr_text ? summaryBlock(doc.processing_ocr_text as string) : "      (no OCR stored)");
    report.push("");

    report.push("  WHAT WE STORED — claim header:");
    report.push(
      `      billed ${money(c.total_billed)}   patient owes ${money(c.total_patient_responsibility)}   patient paid ${money(c.total_patient_paid)}   insurer paid ${money(c.total_insurance_paid)}   ins adjusted ${money(c.total_insurance_adjusted)}`,
    );
    report.push("");
    report.push("  WHAT WE STORED — per line:");
    report.push("      #  billed     owes       paid       ins paid   ins adj    description");
    for (const l of ls) {
      report.push(
        `      ${String(l.line_number).padEnd(2)} ${money(l.billed_amount).padEnd(10)} ${money(l.patient_owes).padEnd(10)} ${money(l.patient_paid_amount).padEnd(10)} ${money(l.insurance_paid).padEnd(10)} ${money(l.insurance_adjusted_amount).padEnd(10)} ${String(l.description ?? "").slice(0, 34)}`,
      );
    }
    report.push("");

    // What the user is currently asked, using today's rule: any per-line sum that
    // differs from the header by more than a cent becomes a question.
    const asks: string[] = [];
    for (const [label, headerCol, lineCol] of [
      ["what you owe", "total_patient_responsibility", "patient_owes"],
      ["what you've paid", "total_patient_paid", "patient_paid_amount"],
      ["what your insurer paid", "total_insurance_paid", "insurance_paid"],
      ["the insurer's adjustments", "total_insurance_adjusted", "insurance_adjusted_amount"],
    ] as const) {
      const header = c[headerCol] != null ? Number(c[headerCol]) : null;
      if (header == null) continue;
      const sum = ls.reduce((s, l) => s + (l[lineCol] != null ? Number(l[lineCol]) : 0), 0);
      if (Math.abs(sum - header) > 0.01) {
        asks.push(
          `      "${label}": line items give $${sum.toFixed(2)}, the bill's summary says $${header.toFixed(2)}. Which is right?`,
        );
      }
    }
    const answered = ((c.metadata as Record<string, unknown> | null)?.userTotalsSource as string) ?? null;
    report.push("  WHAT WE ASK THE USER TODAY:");
    report.push(asks.length ? asks.join("\n") : "      (nothing — no disagreement)");
    if (answered) report.push(`      [already answered: "${answered}"]`);
    report.push("");

    if (doc?.storage_path) {
      const dl = await sb.storage.from("documents").download(doc.storage_path as string);
      if (dl.error || !dl.data) {
        missing.push(`${short}  ${doc.file_name}  — ${dl.error?.message ?? "no data"}`);
        report.push(`  ORIGINAL: NOT AVAILABLE (${dl.error?.message ?? "no data"})`);
      } else {
        const ext = String(doc.file_name).split(".").pop() ?? "pdf";
        const name = `${short}_${String(c.date_of_service)}.${ext}`;
        writeFileSync(join(OUT, "bills", name), Buffer.from(await dl.data.arrayBuffer()));
        downloaded.push(name);
        report.push(`  ORIGINAL: bills/${name}`);
      }
    }
    report.push("");
  }

  report.push("=".repeat(78));
  report.push(`Originals downloaded: ${downloaded.length}`);
  if (missing.length) {
    report.push(`Originals NOT available (${missing.length}) — listed, never silently dropped:`);
    for (const m of missing) report.push(`  ${m}`);
  }

  const path = join(OUT, "spotcheck.txt");
  writeFileSync(path, report.join("\n"));
  console.log(report.join("\n").slice(0, 3000));
  console.log(`\n\nFull sheet → ${path}`);
  console.log(`Originals  → ${join(OUT, "bills")}  (${downloaded.length} files, ${missing.length} unavailable)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
