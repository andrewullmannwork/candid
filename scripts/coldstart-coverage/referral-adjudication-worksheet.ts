/**
 * Step-0 REFERRAL ADJUDICATION worksheet → Obsidian (Group B; S241).
 *
 * Emits an Obsidian Markdown TABLE into the vault for Andrew to adjudicate the parser's
 * referralRequired verdicts. For every referral=TRUE / referral=NULL / visitLimit!=null
 * service it surfaces:
 *   - the REFERRAL BASIS — verbatim OCR line(s) mentioning "referral" (the plan-level
 *     specialist-referral question + answer, plus any per-service callout) — the SOURCE TEXT
 *     to judge the verdict against (independent of the parser; raw OCR grep);
 *   - a Supabase link (documents row, by id);
 *   - a blank Verdict column.
 * Re-extracts ON over the CACHED OCR (reuses the expensive Document-AI OCR; only the cheap
 * Haiku call re-runs). Non-mutating (no DB writes).
 *
 * Fixes the oracle's emit gate (`ref!==null || vl!==null`) which silently dropped the
 * referral=null rows Andrew must adjudicate.
 *
 * Run from the worktree root:
 *   OCR_DIR=<ocr-cache> npx tsx scripts/coldstart-coverage/referral-adjudication-worksheet.ts
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
const VAULT_OUT =
  process.env.VAULT_OUT ||
  "/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/coverage-dims-adjudication-2026-06-26";
const SUPABASE_PROJECT = "viahlyugpuviaskpdvce";
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;
const CONC = parseInt(process.env.CONC || "5", 10);

/** Specialist-type slugs: under a plan-level "YES referral", these are the ones rule-2 turns true. */
const SPECIALIST_SLUGS = new Set([
  "specialist_visit", "advanced_imaging", "diagnostic_test", "imaging_basic",
  "pt_rehab", "ot_rehab", "speech_therapy", "chiropractic", "acupuncture",
  "mental_health_outpatient", "substance_abuse_outpatient", "cardiac_rehab",
]);

/** Markdown-table-cell-safe: strip pipes/newlines/tabs, collapse whitespace, cap length. */
const cell = (s: string, max = 200) =>
  (s ?? "").replace(/\|/g, "¦").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "—";

/**
 * Referral BASIS from raw OCR: the verbatim line(s) mentioning "referral" (+ the next 2 lines,
 * since pdftotext splits the SBC "Do you need a referral…? / Yes" Q&A across lines).
 */
function referralBasis(ocr: string): string {
  const lines = ocr.split(/\r?\n/);
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/referral/i.test(lines[i])) {
      const window = lines.slice(i, i + 3).map((l) => l.trim()).filter(Boolean).join(" / ").replace(/\s+/g, " ").slice(0, 220);
      if (window && !hits.some((h) => h.slice(0, 50) === window.slice(0, 50))) hits.push(window);
    }
    if (hits.length >= 4) break;
  }
  return hits.length ? hits.join("  ‖  ") : "(NO 'referral' text in document)";
}

async function extractON(ocr: string): Promise<PlanDocService[]> {
  const ld = detectLayout(ocr);
  const layout = ld.layout === "unknown" ? undefined : ld.layout;
  const r = await extractServicesCostSharing(
    ocr, { start: 0, end: ocr.length }, "ocr", "services_cost_sharing",
    layout, /*thesaurus*/ true, /*extractionV2*/ true, /*coverageDims*/ true,
  );
  return r.data.services;
}

async function pool<T, R>(items: T[], fn: (t: T) => Promise<R>, conc: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

type Row = {
  docId: string; plan: string; slug: string; pos: string;
  referral: boolean | null; visit: number | null; annualLimit: string;
  basis: string; cost: string; conditions: string; specialist: boolean;
};

const sbLink = (docId: string) =>
  `[\`${docId.slice(0, 8)}\`](https://supabase.com/dashboard/project/${SUPABASE_PROJECT}/editor?schema=public&table=documents&filter=id%3Aeq%3A${docId})`;

function mdTable(rows: Row[], includeSpecialist: boolean): string {
  const head = includeSpecialist
    ? "| Plan (Supabase) | Service | Place | referral | specialist? | Referral basis (plan-level) | Per-svc conditions (rule-1 trigger) | Cost excerpt | **Verdict** |\n|---|---|---|:--:|:--:|---|---|---|---|"
    : "| Plan (Supabase) | Service | Place | visitLimit | annualLimit | Cost excerpt | **Verdict** |\n|---|---|---|:--:|---|---|---|";
  const body = rows.map((r) =>
    includeSpecialist
      ? `| ${sbLink(r.docId)} | \`${r.slug}\` | ${r.pos} | **${r.referral}** | ${r.specialist ? "✓" : ""} | ${cell(r.basis, 160)} | ${cell(r.conditions, 120)} | ${cell(r.cost, 80)} |  |`
      : `| ${sbLink(r.docId)} | \`${r.slug}\` | ${r.pos} | **${r.visit}** | ${cell(r.annualLimit, 90)} | ${cell(r.cost, 90)} |  |`,
  ).join("\n");
  return `${head}\n${body}`;
}

(async () => {
  mkdirSync(VAULT_OUT, { recursive: true });
  const files = readdirSync(OCR_DIR).filter((f) => f.endsWith(".txt")).slice(0, LIMIT);
  console.log(`Corpus: ${files.length} plans · ON-only · conc=${CONC} · OCR=${OCR_DIR}`);

  const jobs = files.map((f) => ({ docId: f.replace(/\.txt$/, ""), ocr: readFileSync(join(OCR_DIR, f), "utf8") }));
  const results = await pool(jobs, async (j) => ({ ...j, svcs: await extractON(j.ocr) }), CONC);

  const rows: Row[] = [];
  let nTrue = 0, nNull = 0, nVisit = 0;
  for (const r of results) {
    const basis = referralBasis(r.ocr);
    for (const s of r.svcs) {
      const ref = s.referralRequired ?? null, vl = s.visitLimit ?? null;
      if (ref !== true && ref !== null && vl === null) continue;
      if (ref === true) nTrue++;
      if (ref === null) nNull++;
      if (vl !== null) nVisit++;
      rows.push({
        docId: r.docId, plan: r.docId.slice(0, 8), slug: s.serviceSlug, pos: s.placeOfService ?? "any",
        referral: ref, visit: vl, annualLimit: s.annualLimit ?? "", basis,
        cost: s.patternP8?.source_excerpt ?? "", conditions: s.coverageConditions ?? "",
        specialist: SPECIALIST_SLUGS.has(s.serviceSlug),
      });
    }
  }
  const byPlan = (a: Row, b: Row) => a.plan.localeCompare(b.plan) || a.slug.localeCompare(b.slug);
  const trueRows = rows.filter((r) => r.referral === true).sort(byPlan);
  const nullRows = rows.filter((r) => r.referral === null).sort(byPlan);
  const visitRows = rows.filter((r) => r.visit !== null).sort(byPlan);

  const md = `# Coverage-Dims Adjudication — Referral + Visit Limit (S241, Group B)

> Parser: \`coverage_dims_v1\` ON, fresh re-extract over the ${files.length}-plan cached OCR corpus (\`c57ce5a\`).
> **You are the oracle.** For each row, judge the parser's verdict against the **Referral basis** (the verbatim source text). Fill **Verdict**: \`✓\` (correct) · \`✗→true\` / \`✗→false\` / \`✗→null\` (wrong, should be X).
> Supabase link → the \`documents\` row by id (filter may need a click in your Studio version; the 8-char id is the doc prefix).
> Counts: **referral=true ${nTrue} · referral=null ${nNull} · visitLimit ${nVisit}**.

## Referral rule (what the parser was told)
1. Explicit per-service text wins ("referral required" → true; "no referral / self-referral / direct access" → false).
2. Plan-level "Do you need a referral to see a specialist?": **YES** → specialist-type services = true; **NO** → all medical = false.
3. Categorically un-gated (pcp, preventive, immunizations, annual_physical, er, urgent) = false.
4. Pharmacy (\`*_rx_*\`) = false (drugs are prescribed, not referred — auth/step-therapy gate them, not referral).
5. Otherwise → null (don't guess).

**Watch for referral↔prior-auth conflation:** inpatient / surgery / SNF / DME / hospice are usually **prior-auth**-gated, not PCP-**referral**-gated. If a plan marks those \`referral=true\` with no referral basis naming them, that's likely the parser over-applying a plan-level YES (→ \`✗→false\`).

---

## 1 · referral = TRUE (${nTrue}) — does the basis justify TRUE?

${mdTable(trueRows, true)}

---

## 2 · referral = NULL (${nNull}) — is ambiguity right, or should it be true/false?

${mdTable(nullRows, true)}

---

## 3 · visitLimit non-null (${nVisit}) — spot-confirm COUNT (not a dollar cap)

${mdTable(visitRows, false)}
`;

  const outPath = join(VAULT_OUT, "referral-adjudication.md");
  writeFileSync(outPath, md);
  console.log(`\nreferral=true ${nTrue} · referral=null ${nNull} · visitLimit ${nVisit}`);
  console.log(`Obsidian worksheet → ${outPath}`);
})();
