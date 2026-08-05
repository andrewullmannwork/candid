/**
 * S304 — BEFORE / AFTER dry-run for the per-line totals plan (tracker Item AD).
 *
 * READ-ONLY. Writes nothing to the database and touches no production file.
 *
 * WHAT THE PLAN IS, AND WHAT THIS PROVES
 * --------------------------------------
 * A bill states its adjudication either PER LINE or ONCE for the whole bill.
 * We modelled only the first and treated the second as a broken version of it —
 * comparing a header figure against the sum of line values that were never
 * printed, and calling the difference a disagreement for the user to settle.
 *
 * Five changes, each modelled here before a production file is edited:
 *
 *   1. SINGLE-LINE IDENTITY   one line → the header IS that line's value. Not an
 *                             allocation; with one line there is nothing to
 *                             allocate across. Lands at the exit of
 *                             `parseBillWithHaiku`, where all three ingest paths
 *                             and all four consumers already converge.
 *   2. NO FABRICATED ZEROS    persist.ts coerces the parser's `null` to `0` on
 *                             two columns. Delete it; `null` means "not stated".
 *   3. ABSENT ≠ CONTRADICTS   ask the user only when line values EXIST and
 *                             disagree with the header. Absent is not a conflict.
 *   4. BILLED RECONCILIATION  sum(line billed) vs the summary's total billed is
 *                             the one apples-to-apples check these documents
 *                             support, and we do not currently make it.
 *   5. PROVIDER ADJUSTED      parsed on both paths, stored nowhere. Without it
 *                             the bill's own arithmetic cannot be reproduced.
 *
 * The evaluation uses the PRODUCTION resolver (`resolveEffectiveClaimTotals`)
 * rather than a reimplementation, so the harness cannot drift from the code.
 *
 * READING THE STORED ROWS HONESTLY
 * --------------------------------
 * A stored `0` in the two coerced columns is ambiguous, but recoverable: if EVERY
 * line reads 0 while that field's header is non-zero, the parser must have emitted
 * `null` — had it emitted real zeros, the sparse-mismatch verifier would have
 * fired and persist would have written `null` instead. `unfabricate()` inverts the
 * coercion so BEFORE reflects what the parser actually said. The same predicate is
 * what a legacy-row cleanup would use, so this run validates it too.
 *
 * Usage:
 *   npx tsx scripts/s304-fill-dryrun.ts
 *   npx tsx scripts/s304-fill-dryrun.ts --out snapshot.json
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { applySingleLineHeaderIdentity } from "../src/lib/billing/header-identity";
import {
  resolveEffectiveClaimTotals,
  isPerLineCiteGrade,
  readUserTotalsSource,
  type EffectiveTotalsLineInput,
} from "../src/lib/claims/effective-totals";

config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 ? process.argv[outArg + 1] : null;

/** The four adjudicated money fields, header column ↔ line column. */
const FIELDS = [
  { label: "patient_owes", header: "total_patient_responsibility", line: "patient_owes", provenance: "patientResponsibilitySource", coerced: false },
  { label: "patient_paid", header: "total_patient_paid", line: "patient_paid_amount", provenance: "patientPaidSource", coerced: true },
  { label: "insurance_paid", header: "total_insurance_paid", line: "insurance_paid", provenance: "insurancePaidSource", coerced: false },
  { label: "ins_adjusted", header: "total_insurance_adjusted", line: "insurance_adjusted_amount", provenance: "insuranceAdjustedSource", coerced: true },
] as const;

type Line = Record<string, number | null>;
type Header = Record<string, number | null>;

// ── change 2, inverted: recover what the parser said ────────────────────────
function unfabricate(lines: Line[], header: Header): Line[] {
  const out = lines.map((l) => ({ ...l }));
  for (const f of FIELDS) {
    if (!f.coerced) continue;
    const h = header[f.header];
    if (h == null || Number(h) === 0) continue;
    if (out.every((l) => l[f.line] != null && Number(l[f.line]) === 0)) {
      for (const l of out) l[f.line] = null;
    }
  }
  return out;
}

// ── change 1: the single-line identity ──────────────────────────────────────
// SHIPPED. This calls the production function (`applySingleLineHeaderIdentity`,
// which runs at the exit of `parseBillWithHaiku`) rather than a copy of its
// logic — so this harness cannot drift from the code it is measuring. The DB
// row → ParsedBill shape adaptation below is the only thing local to the script.
const DB_TO_PARSED: ReadonlyArray<{ db: string; parsed: string }> = [
  { db: "billed_amount", parsed: "billedAmount" },
  { db: "allowed_amount", parsed: "allowedAmount" },
  { db: "insurance_paid", parsed: "insurancePaid" },
  { db: "patient_owes", parsed: "patientResponsibility" },
  { db: "patient_paid_amount", parsed: "patient_paid" },
  { db: "insurance_adjusted_amount", parsed: "ins_adjusted" },
];
const HEADER_TO_TOTALS: ReadonlyArray<{ db: string; parsed: string }> = [
  { db: "total_billed", parsed: "totalBilled" },
  { db: "total_allowed", parsed: "totalAllowed" },
  { db: "total_insurance_paid", parsed: "totalInsurancePaid" },
  { db: "total_patient_responsibility", parsed: "totalPatientResponsibility" },
  { db: "total_patient_paid", parsed: "totalPatientPaid" },
  { db: "total_insurance_adjusted", parsed: "totalInsAdjusted" },
];

function applySingleLineIdentity(lines: Line[], header: Header): { lines: Line[]; filled: string[] } {
  if (lines.length !== 1) return { lines, filled: [] };

  const parsedLine: Record<string, unknown> = {};
  for (const m of DB_TO_PARSED) if (lines[0][m.db] != null) parsedLine[m.parsed] = Number(lines[0][m.db]);
  const totals: Record<string, unknown> = {};
  for (const m of HEADER_TO_TOTALS) if (header[m.db] != null) totals[m.parsed] = Number(header[m.db]);

  const bill = { lineItems: [parsedLine], totals } as unknown as Parameters<typeof applySingleLineHeaderIdentity>[0];
  const { filled } = applySingleLineHeaderIdentity(bill);

  // Map the mutated ParsedBill line back to DB column names.
  const out: Line = { ...lines[0] };
  for (const m of DB_TO_PARSED) {
    const v = (parsedLine as Record<string, unknown>)[m.parsed];
    out[m.db] = typeof v === "number" ? v : null;
  }
  return { lines: [out], filled };
}

// ── change 4: the one apples-to-apples reconciliation ───────────────────────
// Tolerance mirrors `verifyPerLineSums` — max(abs, header × rel) from the
// bill_parser_tool_use_v1 flag config; no new constant invented here.
const TOL_ABS = 0.01;
const TOL_REL = 0.001;
function billedReconciles(lines: Line[], header: Header): { ok: boolean; sum: number; header: number | null; delta: number } {
  const h = header.total_billed != null ? Number(header.total_billed) : null;
  const sum = lines.reduce((s, l) => s + (l.billed_amount != null ? Number(l.billed_amount) : 0), 0);
  if (h == null) return { ok: true, sum, header: null, delta: 0 };
  const delta = Math.abs(sum - h);
  return { ok: delta <= Math.max(TOL_ABS, h * TOL_REL), sum, header: h, delta };
}

// ── change 5: does the bill's own arithmetic close? ─────────────────────────
// billed − ins adjusted − ins paid − provider adjusted = amount due.
// `providerAdjusted` is read from OCR here ONLY to show what the missing column
// costs; after change 5 it comes from claims.metadata.
function arithmeticCloses(header: Header, providerAdjusted: number | null) {
  const billed = header.total_billed != null ? Number(header.total_billed) : null;
  const due = header.total_patient_responsibility != null ? Number(header.total_patient_responsibility) : null;
  if (billed == null || due == null) return { known: false, without: 0, with: 0, okWithout: false, okWith: false };
  const insAdj = Number(header.total_insurance_adjusted ?? 0);
  const insPaid = Number(header.total_insurance_paid ?? 0);
  const without = Math.round((billed - insAdj - insPaid - due) * 100) / 100;
  const wth = Math.round((billed - insAdj - insPaid - (providerAdjusted ?? 0) - due) * 100) / 100;
  return { known: true, without, with: wth, okWithout: Math.abs(without) <= 0.01, okWith: Math.abs(wth) <= 0.01 };
}

const PROVIDER_ADJ = /provider\s+adjust\w*:?\s*-?\$?\s*([\d,]+\.\d{2})/i;
function providerAdjustedFromOcr(ocr: string | null): number | null {
  if (!ocr) return null;
  const m = ocr.match(PROVIDER_ADJ);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

interface FieldState { header: number | null; sum: number; present: boolean; source: string; citeGrade: boolean }

function evaluate(header: Header, lines: Line[], userChoice: ReturnType<typeof readUserTotalsSource>) {
  const eff = resolveEffectiveClaimTotals({
    claim: header as never,
    lineItems: lines as unknown as EffectiveTotalsLineInput[],
    userTotalsSource: userChoice,
  });
  const out: Record<string, FieldState> = {};
  for (const f of FIELDS) {
    const h = header[f.header] != null ? Number(header[f.header]) : null;
    const sum = lines.reduce((s, l) => s + (l[f.line] != null ? Number(l[f.line]) : 0), 0);
    const source = (eff.provenance as unknown as Record<string, string>)[f.provenance];
    out[f.label] = {
      header: h,
      sum,
      present: lines.some((l) => l[f.line] != null),
      source,
      citeGrade: isPerLineCiteGrade(source as never),
    };
  }
  return out;
}

/** Today's rule: ANY delta over a cent becomes a question. */
function firesBefore(st: Record<string, FieldState>): boolean {
  return FIELDS.some((f) => st[f.label].header != null && Math.abs(st[f.label].sum - st[f.label].header!) > 0.01);
}
/** Change 3: only when line values EXIST and disagree. */
function firesAfter(st: Record<string, FieldState>): boolean {
  return FIELDS.some((f) => st[f.label].present && st[f.label].header != null && Math.abs(st[f.label].sum - st[f.label].header!) > 0.01);
}

async function main() {
  console.log(`Project: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
  console.log("READ-ONLY — no database writes, no production files touched.\n");

  const claims = await sb
    .from("claims")
    .select("id, date_of_service, source_document_id, total_billed, total_allowed, total_patient_responsibility, total_patient_paid, total_insurance_paid, total_insurance_adjusted, metadata")
    .is("deleted_at", null)
    .order("date_of_service", { ascending: true });
  if (claims.error) throw new Error(`claims: ${claims.error.message}`);

  const lineRows = await sb
    .from("claim_line_items")
    .select("claim_id, line_number, billed_amount, allowed_amount, patient_owes, patient_paid_amount, insurance_paid, insurance_adjusted_amount");
  if (lineRows.error) throw new Error(`claim_line_items: ${lineRows.error.message}`);

  const docs = await sb
    .from("documents")
    .select("id, classified_type, doc_type, processing_ocr_text")
    .in("id", (claims.data as Array<Record<string, unknown>>).map((c) => c.source_document_id as string).filter(Boolean));
  if (docs.error) throw new Error(`documents: ${docs.error.message}`);
  const docById = new Map((docs.data as Array<Record<string, unknown>>).map((d) => [d.id as string, d]));

  const byClaim = new Map<string, Line[]>();
  for (const l of lineRows.data as unknown as Line[]) {
    const k = (l as unknown as Record<string, string>).claim_id;
    if (!byClaim.has(k)) byClaim.set(k, []);
    byClaim.get(k)!.push(l);
  }

  const rows: string[] = [];
  const snapshot: unknown[] = [];
  let bQ = 0, aQ = 0, liveQ = 0, bCite = 0, aCite = 0, bFly = 0, aFly = 0, changed = 0;
  let billedFail = 0, arithFailWithout = 0, arithFailWith = 0, provAdjFound = 0;
  const outcomes: Record<string, number> = {};

  for (const c of claims.data as Array<Record<string, unknown>>) {
    const id = c.id as string;
    const header = c as unknown as Header;
    const raw = byClaim.get(id) ?? [];
    if (raw.length === 0) continue;
    const doc = c.source_document_id ? docById.get(c.source_document_id as string) : null;
    const docType = String(doc?.classified_type ?? doc?.doc_type ?? "?");
    const userChoice = readUserTotalsSource(c.metadata);

    const before = unfabricate(raw, header);
    const { lines: after, filled } = applySingleLineIdentity(before, header);

    const bSt = evaluate(header, before, userChoice);
    const aSt = evaluate(header, after, userChoice);
    const bFires = firesBefore(bSt);
    const aFires = firesAfter(aSt);
    // What the running app shows RIGHT NOW: the shipped rule against the rows as
    // they stand. Differs from AFTER only where a re-parse would add the
    // single-line identity, which no backfill applies.
    const liveFires = firesAfter(bSt);
    if (liveFires) liveQ += 1;

    const bill = billedReconciles(after, header);
    const provAdj = providerAdjustedFromOcr((doc?.processing_ocr_text as string) ?? null);
    const arith = arithmeticCloses(header, provAdj);
    if (provAdj != null) provAdjFound++;
    if (!bill.ok) billedFail++;
    if (arith.known && !arith.okWithout) arithFailWithout++;
    if (arith.known && !arith.okWith) arithFailWith++;

    if (bFires) bQ++;
    if (aFires) aQ++;
    for (const f of FIELDS) {
      if (bSt[f.label].citeGrade) bCite++;
      if (aSt[f.label].citeGrade) aCite++;
      if (bSt[f.label].present) bFly++;
      if (aSt[f.label].present) aFly++;
    }
    if (filled.length) changed++;

    // What we SAY in the after state — one outcome per claim.
    const anyAbsent = FIELDS.some((f) => !aSt[f.label].present && aSt[f.label].header != null && Number(aSt[f.label].header) !== 0);
    const outcome = !bill.ok
      ? "CHECK BILLING"
      : aFires
        ? "ASK USER"
        : anyAbsent
          ? "GAP: need EOB"
          : "quiet";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;

    rows.push(
      `${id.slice(0, 8)}  ${String(c.date_of_service).padEnd(10)} ${docType.slice(0, 13).padEnd(13)} ${String(raw.length).padStart(2)}  ` +
        `${(bFires ? "ASK" : "—").padEnd(4)}${(aFires ? "ASK" : "—").padEnd(5)}` +
        `${String(FIELDS.filter((f) => bSt[f.label].citeGrade).length).padStart(2)}→${String(FIELDS.filter((f) => aSt[f.label].citeGrade).length).padEnd(3)}` +
        `${String(FIELDS.filter((f) => bSt[f.label].present).length).padStart(2)}→${String(FIELDS.filter((f) => aSt[f.label].present).length).padEnd(3)}` +
        `${(bill.ok ? "ok" : `OFF $${bill.delta.toFixed(2)}`).padEnd(11)}` +
        `${(!arith.known ? "n/a" : arith.okWithout ? "ok" : arith.okWith ? `needs $${(provAdj ?? 0).toFixed(2)}` : `OFF $${Math.abs(arith.with).toFixed(2)}`).padEnd(15)}` +
        outcome,
    );

    snapshot.push({ claimId: id, dos: c.date_of_service, docType, lines: raw.length, filled, before: bSt, after: aSt, billedReconcile: bill, arithmetic: arith, providerAdjusted: provAdj, outcome });
  }

  console.log("claim     date       doc type      n  BEFORE/AFTER  cite  data  billed sum  bill math      outcome after");
  console.log("─".repeat(122));
  for (const r of rows) console.log(r);
  console.log("─".repeat(122));
  console.log("            BEFORE     LIVE    AFTER");
  console.log(`claims asking the question      ${String(bQ).padStart(6)} ${String(liveQ).padStart(8)} ${String(aQ).padStart(8)}`);
  console.log("   BEFORE = the pre-S304 rule (any delta asks) · LIVE = the shipped rule on the rows as they");
  console.log("   stand right now · AFTER = the shipped rule once a re-parse adds the single-line identity.");
  console.log(`cite-grade per-line fields      ${String(bCite).padStart(6)} ${String(aCite).padStart(7)}   (of ${claims.data.length * 4})`);
  console.log(`per-line fields with a value    ${String(bFly).padStart(6)} ${String(aFly).padStart(7)}   ← the flywheel line`);
  console.log(`claims changed by the identity  ${String(changed).padStart(6)}`);
  console.log("");
  console.log(`billed sum ≠ summary total:                  ${billedFail} claims   ← change 4 (new check; duplicates / phantom lines / a misread line all land here)`);
  console.log(`bill arithmetic OFF without provider_adjusted: ${arithFailWithout} claims`);
  console.log(`bill arithmetic OFF with it:                   ${arithFailWith} claims   ← change 5 closes the difference`);
  console.log(`bills printing a "Provider adjusted" line:     ${provAdjFound}`);
  console.log("");
  console.log(`after-state outcomes: ${JSON.stringify(outcomes)}`);

  if (OUT) {
    writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
    console.log(`\nSnapshot → ${OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
