/**
 * PR4b (S143) — multi-insurer bill parser calibration corpus runner.
 *
 * Walks `<corpus-dir>/<insurer>/*.pdf`, runs the bill parser in a deterministic
 * mode (raw_json or tool_use) over each, writes per-bill artifacts to the
 * local-only corpus dir (PHI never enters the vault), and computes parity vs
 * a previously-captured baseline.
 *
 * Per the locked parity definition (C7 extended):
 *   (a) Header monetary fields match within $0.01:
 *       total_billed / total_insurance_paid / total_insurance_adjusted /
 *       total_patient_paid
 *   (b) Per-line ins_adjusted populated rate within 5pp
 *   (c) CPT codes byte-equal line-by-line
 *   (d) Service dates byte-equal (claim header + per line)
 *   (e) denied_amount / ins_adjusted column allocation byte-equal
 *       (semantically-equivalent swap counts as FAIL — different downstream
 *        behavior in dispute pipeline)
 *   (f) Verifier verdicts byte-equal between modes (sign_violation,
 *       per_line_sparse, header_reconciliation_failed)
 *
 * Usage:
 *   npx tsx scripts/calibration/runners/run-bill-corpus.ts --mode=raw_json --baseline-only
 *   npx tsx scripts/calibration/runners/run-bill-corpus.ts --mode=tool_use --iteration=1 \
 *     --baseline-path=~/Desktop/candid/local-only/calibration/bill/_summary/baseline-raw_json.json
 *
 * Per memory project_candid_bill_calibration_corpus: per-bill outputs stay in
 * local-only dir (PHI). Aggregate scorecards go to the vault under
 * plans/findings/opus-parser-calibration-<date>/bill/iteration-<N>.md.
 *
 * DB-bypass: this runner calls parseBillWithHaiku() directly with forceMode +
 * onTrace from ParseBillCalibrationOpts. It does NOT invoke the persist hot
 * path, so it never writes to bill_parser_decisions / claims / claim_line_items.
 */
import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
// Claude Code pre-sets ANTHROPIC_API_KEY="" before runner starts; without
// override:true dotenv won't replace empty-string. Per S127 env-reminder.
dotenvConfig({ path: ".env.local", override: true });

import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { parseBillWithHaiku } from "../../../src/lib/billing/haiku-bill-parser.js";
import { extractTextFromDocument } from "../../../src/lib/ocr/index.js";
import {
  detectSignViolations,
  verifyPerLineSums,
  verifyHeaderReconciliation,
  type VerifierTolerances,
} from "../../../src/lib/billing/sum-invariants.js";
import { computeVerdict } from "../../../src/lib/billing/bill-parser-decisions.js";
import type { ParsedBill, BillLineItem } from "../../../src/lib/billing/types.js";

// Haiku 4.5 pricing per Anthropic docs (https://docs.anthropic.com/en/docs/about-claude/pricing).
const HAIKU_PRICING_PER_MTOKEN = {
  inputUncached: 0.8,
  inputCached: 0.08,
  cacheWrite5m: 1.0,
  output: 4.0,
};

interface CliArgs {
  mode: "raw_json" | "tool_use";
  iteration: number;
  baselineOnly: boolean;
  baselinePath: string | null;
  corpusDir: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const has = (name: string): boolean => args.includes(`--${name}`);

  const mode = (get("mode") ?? "raw_json") as "raw_json" | "tool_use";
  if (mode !== "raw_json" && mode !== "tool_use") {
    throw new Error(`--mode must be raw_json or tool_use, got: ${mode}`);
  }
  const iteration = Number(get("iteration") ?? "0");
  const baselineOnly = has("baseline-only");
  const baselinePath = get("baseline-path") ?? null;
  const corpusDir =
    get("corpus-dir") ??
    path.join(os.homedir(), "Desktop/candid/local-only/calibration/bill");
  const dryRun = has("dry-run");

  if (mode === "tool_use" && !baselineOnly && !baselinePath) {
    throw new Error(
      "tool_use mode requires --baseline-path (raw_json baseline JSON) unless --baseline-only is set",
    );
  }
  return { mode, iteration, baselineOnly, baselinePath, corpusDir, dryRun };
}

const TOLERANCES: VerifierTolerances = {
  perLineSumAbs: 0.01,
  perLineSumRel: 0.001,
  headerReconciliationAbs: 0.5,
  headerReconciliationRel: 0.005,
};

interface PerBillArtifact {
  insurer: string;
  fileName: string;
  fileSize: number;
  ocrCharCount: number;
  billType: "eob" | "itemized_bill";
  mode: "raw_json" | "tool_use";
  iteration: number;
  parsedBill: ParsedBill | null;
  trace: {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
    durationMs: number;
    costUsd: number;
  };
  verifierResult: {
    signViolationFields: string[];
    perLineSumViolations: string[];
    headerReconciliationFailed: boolean;
    headerReconciliationDelta: number | null;
    verdict: string;
    categories: string[];
  } | null;
  timestamp: string;
}

interface BillIdentity {
  insurer: string;
  fileName: string;
  filePath: string;
}

function* walkCorpus(corpusDir: string): Generator<BillIdentity> {
  if (!fs.existsSync(corpusDir)) {
    throw new Error(`Corpus dir does not exist: ${corpusDir}`);
  }
  const insurerDirs = fs
    .readdirSync(corpusDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
  for (const insurer of insurerDirs) {
    const insurerDir = path.join(corpusDir, insurer);
    const pdfs = fs
      .readdirSync(insurerDir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .sort();
    for (const fileName of pdfs) {
      yield { insurer, fileName, filePath: path.join(insurerDir, fileName) };
    }
  }
}

function inferBillType(fileName: string): "eob" | "itemized_bill" {
  const lower = fileName.toLowerCase();
  if (lower.includes("itemized") || lower.includes("bill") && !lower.includes("eob")) {
    return "itemized_bill";
  }
  return "eob";
}

function computeCostUsd(usage: PerBillArtifact["trace"]["usage"]): number {
  if (!usage) return 0;
  const uncached = Math.max(
    0,
    usage.input_tokens -
      (usage.cache_creation_input_tokens ?? 0) -
      (usage.cache_read_input_tokens ?? 0),
  );
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens;
  return (
    (uncached * HAIKU_PRICING_PER_MTOKEN.inputUncached +
      cacheWrite * HAIKU_PRICING_PER_MTOKEN.cacheWrite5m +
      cacheRead * HAIKU_PRICING_PER_MTOKEN.inputCached +
      output * HAIKU_PRICING_PER_MTOKEN.output) /
    1_000_000
  );
}

function runVerifiers(parsedBill: ParsedBill): PerBillArtifact["verifierResult"] {
  if (!parsedBill) return null;
  const signViolations = detectSignViolations(parsedBill);
  const perLineVerdicts = verifyPerLineSums(parsedBill, TOLERANCES);
  const headerVerdict = verifyHeaderReconciliation(parsedBill, TOLERANCES);
  const { verdict, categories } = computeVerdict(signViolations, perLineVerdicts, headerVerdict);
  const perLineViolations = perLineVerdicts
    .filter((v) => v.populated && !v.withinTolerance)
    .map((v) => v.field);
  const signFields = Array.from(new Set(signViolations.map((s) => s.field)));
  return {
    signViolationFields: signFields,
    perLineSumViolations: perLineViolations,
    headerReconciliationFailed:
      headerVerdict.allHeaderTotalsPresent && !headerVerdict.withinTolerance,
    headerReconciliationDelta: Number.isFinite(headerVerdict.delta)
      ? headerVerdict.delta
      : null,
    verdict,
    categories,
  };
}

async function parseOneBill(bill: BillIdentity, mode: "raw_json" | "tool_use", iteration: number, dryRun: boolean): Promise<PerBillArtifact> {
  const buffer = fs.readFileSync(bill.filePath);
  const fileSize = buffer.byteLength;
  const billType = inferBillType(bill.fileName);
  const timestamp = new Date().toISOString();

  if (dryRun) {
    return {
      insurer: bill.insurer,
      fileName: bill.fileName,
      fileSize,
      ocrCharCount: 0,
      billType,
      mode,
      iteration,
      parsedBill: null,
      trace: { usage: null, durationMs: 0, costUsd: 0 },
      verifierResult: null,
      timestamp,
    };
  }

  const ocr = await extractTextFromDocument(buffer, "application/pdf");
  const ocrText = ocr.text;
  const docId = randomUUID();
  const userId = randomUUID();

  let captured: PerBillArtifact["trace"] = { usage: null, durationMs: 0, costUsd: 0 };
  const parsedBill = await parseBillWithHaiku(
    ocrText,
    docId,
    userId,
    billType,
    "pdftotext",
    {
      forceMode: mode,
      onTrace: (trace) => {
        const usage = {
          input_tokens: trace.usage.input_tokens,
          output_tokens: trace.usage.output_tokens,
          cache_creation_input_tokens: (trace.usage as unknown as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
          cache_read_input_tokens: (trace.usage as unknown as { cache_read_input_tokens?: number }).cache_read_input_tokens,
        };
        captured = {
          usage,
          durationMs: trace.durationMs,
          costUsd: computeCostUsd(usage),
        };
      },
    },
  );

  const verifierResult = parsedBill ? runVerifiers(parsedBill) : null;
  return {
    insurer: bill.insurer,
    fileName: bill.fileName,
    fileSize,
    ocrCharCount: ocrText.length,
    billType,
    mode,
    iteration,
    parsedBill,
    trace: captured,
    verifierResult,
    timestamp,
  };
}

function artifactPath(corpusDir: string, bill: BillIdentity, mode: string, iteration: number): string {
  const stem = bill.fileName.replace(/\.pdf$/i, "");
  return path.join(
    corpusDir,
    bill.insurer,
    `${stem}.${mode}${iteration > 0 ? `.iter-${iteration}` : ""}.json`,
  );
}

interface ParityReport {
  bill: BillIdentity;
  raw: PerBillArtifact;
  candidate: PerBillArtifact;
  checks: {
    headerMonetary: { passed: boolean; details: Record<string, { raw: number | null; cand: number | null; deltaAbs: number; withinTolerance: boolean }> };
    perLineInsAdjustedPopRate: { passed: boolean; rawPopRate: number; candPopRate: number; deltaPp: number };
    cptCodes: { passed: boolean; mismatches: Array<{ lineIdx: number; raw: string; cand: string }> };
    serviceDates: { passed: boolean; mismatches: Array<{ lineIdx: number | "header"; raw: string; cand: string }> };
    denyAdjustAllocation: { passed: boolean; mismatches: Array<{ lineIdx: number; rawDenied: number | null; candDenied: number | null; rawInsAdj: number | null; candInsAdj: number | null }> };
    verdictConsistency: { passed: boolean; rawVerdict: string; candVerdict: string };
  };
  overall: "PASS" | "FAIL";
}

function computeParity(raw: PerBillArtifact, cand: PerBillArtifact, bill: BillIdentity): ParityReport {
  const headerFields = [
    ["totalBilled", "total_billed"],
    ["totalInsurancePaid", "total_insurance_paid"],
    ["totalInsAdjusted", "total_insurance_adjusted"],
    ["totalPatientPaid", "total_patient_paid"],
  ] as const;
  const headerDetails: Record<string, { raw: number | null; cand: number | null; deltaAbs: number; withinTolerance: boolean }> = {};
  let headerAllPass = true;
  for (const [parsedKey, displayKey] of headerFields) {
    const r = (raw.parsedBill?.totals as Record<string, number | undefined>)?.[parsedKey] ?? null;
    const c = (cand.parsedBill?.totals as Record<string, number | undefined>)?.[parsedKey] ?? null;
    const deltaAbs = Math.abs((r ?? 0) - (c ?? 0));
    const withinTolerance = deltaAbs <= 0.01 && (r == null) === (c == null);
    headerDetails[displayKey] = { raw: r, cand: c, deltaAbs, withinTolerance };
    if (!withinTolerance) headerAllPass = false;
  }

  const rawLines = raw.parsedBill?.lineItems ?? [];
  const candLines = cand.parsedBill?.lineItems ?? [];
  const rawInsAdjPop = rawLines.filter((l) => l.ins_adjusted != null).length;
  const candInsAdjPop = candLines.filter((l) => l.ins_adjusted != null).length;
  const rawPopRate = rawLines.length ? rawInsAdjPop / rawLines.length : 0;
  const candPopRate = candLines.length ? candInsAdjPop / candLines.length : 0;
  const deltaPp = Math.abs(rawPopRate - candPopRate) * 100;
  const perLinePopPassed = deltaPp <= 5;

  const cptMismatches: Array<{ lineIdx: number; raw: string; cand: string }> = [];
  const minLen = Math.min(rawLines.length, candLines.length);
  for (let i = 0; i < minLen; i++) {
    const r = rawLines[i].procedureCode ?? "";
    const c = candLines[i].procedureCode ?? "";
    if (r !== c) cptMismatches.push({ lineIdx: i, raw: r, cand: c });
  }
  const cptPassed = cptMismatches.length === 0 && rawLines.length === candLines.length;

  const dateMismatches: Array<{ lineIdx: number | "header"; raw: string; cand: string }> = [];
  const rawHeaderDate = raw.parsedBill?.serviceDate ?? "";
  const candHeaderDate = cand.parsedBill?.serviceDate ?? "";
  if (rawHeaderDate !== candHeaderDate) dateMismatches.push({ lineIdx: "header", raw: rawHeaderDate, cand: candHeaderDate });
  for (let i = 0; i < minLen; i++) {
    const r = rawLines[i].serviceDate ?? "";
    const c = candLines[i].serviceDate ?? "";
    if (r !== c) dateMismatches.push({ lineIdx: i, raw: r, cand: c });
  }
  const datesPassed = dateMismatches.length === 0;

  const allocMismatches: Array<{ lineIdx: number; rawDenied: number | null; candDenied: number | null; rawInsAdj: number | null; candInsAdj: number | null }> = [];
  for (let i = 0; i < minLen; i++) {
    const rD = rawLines[i].denied_amount ?? null;
    const cD = candLines[i].denied_amount ?? null;
    const rI = rawLines[i].ins_adjusted ?? null;
    const cI = candLines[i].ins_adjusted ?? null;
    const deniedSame = (rD == null) === (cD == null) && Math.abs((rD ?? 0) - (cD ?? 0)) <= 0.01;
    const insAdjSame = (rI == null) === (cI == null) && Math.abs((rI ?? 0) - (cI ?? 0)) <= 0.01;
    if (!deniedSame || !insAdjSame) {
      allocMismatches.push({ lineIdx: i, rawDenied: rD, candDenied: cD, rawInsAdj: rI, candInsAdj: cI });
    }
  }
  const allocPassed = allocMismatches.length === 0;

  const rawVerdict = raw.verifierResult?.verdict ?? "no_bill";
  const candVerdict = cand.verifierResult?.verdict ?? "no_bill";
  const verdictPassed = rawVerdict === candVerdict;

  const overall: "PASS" | "FAIL" = headerAllPass && perLinePopPassed && cptPassed && datesPassed && allocPassed && verdictPassed ? "PASS" : "FAIL";
  return {
    bill,
    raw,
    candidate: cand,
    checks: {
      headerMonetary: { passed: headerAllPass, details: headerDetails },
      perLineInsAdjustedPopRate: { passed: perLinePopPassed, rawPopRate, candPopRate, deltaPp },
      cptCodes: { passed: cptPassed, mismatches: cptMismatches },
      serviceDates: { passed: datesPassed, mismatches: dateMismatches },
      denyAdjustAllocation: { passed: allocPassed, mismatches: allocMismatches },
      verdictConsistency: { passed: verdictPassed, rawVerdict, candVerdict },
    },
    overall,
  };
}

interface SummaryReport {
  date: string;
  mode: "raw_json" | "tool_use";
  iteration: number;
  schemaVersion: string;
  corpus: {
    totalBills: number;
    perInsurer: Record<string, number>;
  };
  parityIfApplicable: {
    globalPass: number;
    globalFail: number;
    perInsurer: Record<string, { pass: number; fail: number }>;
    failingBills: Array<{ insurer: string; fileName: string; failedChecks: string[] }>;
  } | null;
  cost: {
    totalUsd: number;
    avgUsdPerBill: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
  };
  perBillArtifactDir: string;
}

async function main() {
  const args = parseArgs();
  console.log("[run-bill-corpus] args:", args);

  const summaryDir = path.join(args.corpusDir, "_summary");
  fs.mkdirSync(summaryDir, { recursive: true });

  let baselineMap: Map<string, PerBillArtifact> | null = null;
  if (args.baselinePath) {
    const expanded = args.baselinePath.replace(/^~/, os.homedir());
    if (!fs.existsSync(expanded)) {
      throw new Error(`--baseline-path not found: ${expanded}`);
    }
    const parsed = JSON.parse(fs.readFileSync(expanded, "utf-8")) as
      | PerBillArtifact[]
      | { perBill: PerBillArtifact[] };
    const arr: PerBillArtifact[] = Array.isArray(parsed) ? parsed : parsed.perBill;
    baselineMap = new Map();
    for (const r of arr) baselineMap.set(`${r.insurer}/${r.fileName}`, r);
    console.log(`[run-bill-corpus] loaded ${arr.length} baseline rows from ${expanded}`);
  }

  const perBill: PerBillArtifact[] = [];
  const parityReports: ParityReport[] = [];
  const bills = Array.from(walkCorpus(args.corpusDir));
  console.log(`[run-bill-corpus] discovered ${bills.length} bills in corpus`);

  for (const bill of bills) {
    process.stdout.write(`[${bill.insurer}/${bill.fileName}] ... `);
    try {
      const art = await parseOneBill(bill, args.mode, args.iteration, args.dryRun);
      perBill.push(art);
      fs.writeFileSync(artifactPath(args.corpusDir, bill, args.mode, args.iteration), JSON.stringify(art, null, 2));
      if (baselineMap) {
        const baseline = baselineMap.get(`${bill.insurer}/${bill.fileName}`);
        if (baseline) {
          const parity = computeParity(baseline, art, bill);
          parityReports.push(parity);
          console.log(`${parity.overall} (verdict=${art.verifierResult?.verdict ?? "n/a"}, $${art.trace.costUsd.toFixed(4)})`);
        } else {
          console.log(`SKIP (no baseline match)`);
        }
      } else {
        console.log(`done (verdict=${art.verifierResult?.verdict ?? "n/a"}, $${art.trace.costUsd.toFixed(4)})`);
      }
    } catch (err) {
      console.error(`FAIL: ${(err as Error).message}`);
    }
  }

  const cacheReadTokens = perBill.reduce((s, b) => s + (b.trace.usage?.cache_read_input_tokens ?? 0), 0);
  const cacheCreationTokens = perBill.reduce((s, b) => s + (b.trace.usage?.cache_creation_input_tokens ?? 0), 0);
  const uncachedInputTokens = perBill.reduce(
    (s, b) => s + Math.max(0, (b.trace.usage?.input_tokens ?? 0) - (b.trace.usage?.cache_creation_input_tokens ?? 0) - (b.trace.usage?.cache_read_input_tokens ?? 0)),
    0,
  );
  const outputTokens = perBill.reduce((s, b) => s + (b.trace.usage?.output_tokens ?? 0), 0);
  const totalUsd = perBill.reduce((s, b) => s + b.trace.costUsd, 0);

  const perInsurer: Record<string, number> = {};
  for (const a of perBill) perInsurer[a.insurer] = (perInsurer[a.insurer] ?? 0) + 1;

  let parityIfApplicable: SummaryReport["parityIfApplicable"] = null;
  if (parityReports.length) {
    const globalPass = parityReports.filter((r) => r.overall === "PASS").length;
    const globalFail = parityReports.filter((r) => r.overall === "FAIL").length;
    const perIns: Record<string, { pass: number; fail: number }> = {};
    for (const r of parityReports) {
      perIns[r.bill.insurer] = perIns[r.bill.insurer] ?? { pass: 0, fail: 0 };
      if (r.overall === "PASS") perIns[r.bill.insurer].pass += 1;
      else perIns[r.bill.insurer].fail += 1;
    }
    const failingBills = parityReports.filter((r) => r.overall === "FAIL").map((r) => ({
      insurer: r.bill.insurer,
      fileName: r.bill.fileName,
      failedChecks: Object.entries(r.checks).filter(([, v]) => !v.passed).map(([k]) => k),
    }));
    parityIfApplicable = { globalPass, globalFail, perInsurer: perIns, failingBills };
  }

  const summary: SummaryReport = {
    date: new Date().toISOString(),
    mode: args.mode,
    iteration: args.iteration,
    schemaVersion: args.iteration === 0 ? "v1" : `v${args.iteration + 1}`,
    corpus: { totalBills: perBill.length, perInsurer },
    parityIfApplicable,
    cost: {
      totalUsd,
      avgUsdPerBill: perBill.length ? totalUsd / perBill.length : 0,
      cacheReadTokens,
      cacheCreationTokens,
      uncachedInputTokens,
      outputTokens,
    },
    perBillArtifactDir: args.corpusDir,
  };

  const summaryFile = path.join(
    summaryDir,
    `${args.mode}${args.iteration > 0 ? `-iter-${args.iteration}` : ""}.json`,
  );
  fs.writeFileSync(summaryFile, JSON.stringify({ summary, parityReports, perBill }, null, 2));
  console.log(`\n[run-bill-corpus] summary → ${summaryFile}`);
  console.log(`[run-bill-corpus] cost total: $${totalUsd.toFixed(4)} (avg $${(totalUsd / Math.max(1, perBill.length)).toFixed(4)}/bill)`);
  if (parityIfApplicable) {
    console.log(`[run-bill-corpus] parity: ${parityIfApplicable.globalPass} PASS / ${parityIfApplicable.globalFail} FAIL`);
    for (const [ins, c] of Object.entries(parityIfApplicable.perInsurer)) {
      console.log(`  ${ins}: ${c.pass} PASS / ${c.fail} FAIL`);
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
