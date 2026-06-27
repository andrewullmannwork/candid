/**
 * §13 multi-dimension oracle — coverage_dims_v1 (referral + visit_limit).
 *
 * Proves the parser change two ways on the 19-plan adjudicated corpus:
 *   (A) ZERO-REGRESSION on existing dimensions — runs flag-OFF and flag-ON (N each),
 *       measures existing-field disagreement OFF↔ON against the OFF↔OFF model-noise floor.
 *       If signal ≈ noise, the supplement didn't perturb existing extraction.
 *   (B) NEW-DIM capture — collects every referralRequired / visitLimit emission (flag-ON)
 *       with its source_excerpt into a worksheet for Andrew to adjudicate (he is the oracle).
 *
 * Calibration-independent: passes thesaurus + extractionV2 overrides = true (match live PROD),
 * toggles ONLY coverageDimsOverride. Non-mutating (no DB writes). Reads cached whole-text OCR.
 *
 * Run from the worktree root:
 *   OCR_DIR=<ocr-cache> LIMIT=2 N=1 npx tsx scripts/coldstart-coverage/oracle-coverage-dims.ts   # smoke
 *   OCR_DIR=<ocr-cache> npx tsx scripts/coldstart-coverage/oracle-coverage-dims.ts                # full
 */
import { config } from "dotenv";
config({ path: "/Users/andrewullmann/Desktop/candid/.env.local" });

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { extractServicesCostSharing } from "@/lib/plan_doc/haiku-prompts/services-cost-sharing";
import { detectLayout } from "@/lib/plan_doc/layout-detector";
import type { PlanDocService } from "@/lib/plan_doc/types";

const OCR_DIR =
  process.env.OCR_DIR ||
  "/Users/andrewullmann/Desktop/candid/.claude/worktrees/backend-coldstart-regen/.scratch-coldstart/ocr-cache";
const OUT_DIR =
  process.env.OUT_DIR ||
  "/private/tmp/claude-501/-Users-andrewullmann-Desktop-du-weldenvarden/0f85c583-b84a-40c1-9dc1-829deebe9ab5/scratchpad/oracle-out";
const N = parseInt(process.env.N || "2", 10);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const CONC = parseInt(process.env.CONC || "5", 10);

// Existing dimensions whose OFF↔ON stability proves no-regression.
const EXISTING_FIELDS: (keyof PlanDocService)[] = [
  "inCopay", "inCoinsurance", "inDeductibleApplies", "outCopay", "outCoinsurance",
  "outDeductibleApplies", "priorAuthRequired", "annualLimitValue", "covered", "placeOfService",
];

const key = (s: PlanDocService) => `${s.serviceSlug}::${s.placeOfService}::${s.component ?? "global"}`;

async function extract(ocr: string, coverageDims: boolean): Promise<PlanDocService[]> {
  const ld = detectLayout(ocr);
  const layout = ld.layout === "unknown" ? undefined : ld.layout;
  const r = await extractServicesCostSharing(
    ocr, { start: 0, end: ocr.length }, "ocr", "services_cost_sharing",
    layout, /*thesaurus*/ true, /*extractionV2*/ true, /*coverageDims*/ coverageDims,
  );
  return r.data.services;
}

// Compare two service lists: per matched (slug,pos,component) cell, count existing-field disagreements.
function diff(a: PlanDocService[], b: PlanDocService[]) {
  const ma = new Map(a.map((s) => [key(s), s]));
  const mb = new Map(b.map((s) => [key(s), s]));
  let matched = 0, fieldCmp = 0, fieldDisagree = 0, onlyA = 0, onlyB = 0;
  for (const [k, sa] of ma) {
    const sb = mb.get(k);
    if (!sb) { onlyA++; continue; }
    matched++;
    for (const f of EXISTING_FIELDS) {
      fieldCmp++;
      if (JSON.stringify(sa[f] ?? null) !== JSON.stringify(sb[f] ?? null)) fieldDisagree++;
    }
  }
  for (const k of mb.keys()) if (!ma.has(k)) onlyB++;
  return { matched, onlyA, onlyB, fieldCmp, fieldDisagree, disagreeRate: fieldCmp ? fieldDisagree / fieldCmp : 0 };
}

async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>, conc: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(OCR_DIR).filter((f) => f.endsWith(".txt")).slice(0, LIMIT);
  console.log(`Corpus: ${files.length} plans · N=${N}/arm · conc=${CONC} · OCR=${OCR_DIR}`);

  // Build the run list: each plan × {OFF×N, ON×N}.
  type Job = { docId: string; ocr: string; arm: "OFF" | "ON"; run: number };
  const jobs: Job[] = [];
  for (const f of files) {
    const ocr = readFileSync(join(OCR_DIR, f), "utf8");
    const docId = f.replace(/\.txt$/, "");
    for (let r = 0; r < N; r++) jobs.push({ docId, ocr, arm: "OFF", run: r });
    for (let r = 0; r < N; r++) jobs.push({ docId, ocr, arm: "ON", run: r });
  }

  const t0 = Date.now();
  const results = await pool(jobs, async (j) => {
    const svcs = await extract(j.ocr, j.arm === "ON");
    return { docId: j.docId, arm: j.arm, run: j.run, svcs };
  }, CONC);
  console.log(`Extraction done in ${((Date.now() - t0) / 1000).toFixed(0)}s (${jobs.length} calls)`);

  // Index results: docId -> arm -> run -> svcs
  const byDoc = new Map<string, { OFF: PlanDocService[][]; ON: PlanDocService[][] }>();
  for (const f of files) byDoc.set(f.replace(/\.txt$/, ""), { OFF: [], ON: [] });
  for (const r of results) byDoc.get(r.docId)![r.arm][r.run] = r.svcs;

  // (A) Regression: noise floor (OFF0 vs OFF1) vs signal (OFF0 vs ON0).
  let noiseCmp = 0, noiseDis = 0, sigCmp = 0, sigDis = 0;
  let cntOff = 0, cntOn = 0;
  const perPlan: string[] = [];
  for (const [docId, d] of byDoc) {
    const off0 = d.OFF[0] ?? [], on0 = d.ON[0] ?? [];
    cntOff += off0.length; cntOn += on0.length;
    if (N >= 2 && d.OFF[1]) { const n = diff(off0, d.OFF[1]); noiseCmp += n.fieldCmp; noiseDis += n.fieldDisagree; }
    const s = diff(off0, on0); sigCmp += s.fieldCmp; sigDis += s.fieldDisagree;
    perPlan.push(`${docId.slice(0, 8)}  OFF=${off0.length} ON=${on0.length}  matched=${s.matched} onlyOFF=${s.onlyA} onlyON=${s.onlyB}  existing-disagree=${(s.disagreeRate * 100).toFixed(1)}%`);
  }

  // (B) New-dim worksheet from ON run 0.
  const ws: string[] = ["plan\tserviceSlug\tplaceOfService\treferralRequired\tvisitLimit\tannualLimit\tsource_excerpt"];
  let refNonNull = 0, visitNonNull = 0, onTotal = 0;
  for (const [docId, d] of byDoc) {
    for (const s of d.ON[0] ?? []) {
      onTotal++;
      const ref = s.referralRequired ?? null, vl = s.visitLimit ?? null;
      if (ref !== null) refNonNull++;
      if (vl !== null) visitNonNull++;
      if (ref !== null || vl !== null) {
        ws.push(`${docId.slice(0, 8)}\t${s.serviceSlug}\t${s.placeOfService}\t${ref}\t${vl}\t${(s.annualLimit ?? "").replace(/\t/g, " ")}\t${(s.patternP8?.source_excerpt ?? "").replace(/\t|\n/g, " ").slice(0, 160)}`);
      }
    }
  }

  writeFileSync(join(OUT_DIR, "raw.json"), JSON.stringify(Object.fromEntries(byDoc), null, 1));
  writeFileSync(join(OUT_DIR, "new-dims-worksheet.tsv"), ws.join("\n"));

  console.log("\n===== (A) ZERO-REGRESSION on existing dims =====");
  perPlan.forEach((p) => console.log("  " + p));
  console.log(`\n  NOISE floor (OFF↔OFF): ${(100 * (noiseCmp ? noiseDis / noiseCmp : 0)).toFixed(2)}%  (${noiseDis}/${noiseCmp})`);
  console.log(`  SIGNAL    (OFF↔ON):   ${(100 * (sigCmp ? sigDis / sigCmp : 0)).toFixed(2)}%  (${sigDis}/${sigCmp})`);
  console.log(`  service-count OFF=${cntOff} ON=${cntOn} (Δ=${cntOn - cntOff})`);
  console.log("\n===== (B) NEW-DIM capture (flag-ON, run 0) =====");
  console.log(`  ON services: ${onTotal} · referralRequired non-null: ${refNonNull} · visitLimit non-null: ${visitNonNull}`);
  console.log(`  worksheet → ${join(OUT_DIR, "new-dims-worksheet.tsv")}`);
})();
