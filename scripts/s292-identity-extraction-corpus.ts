#!/usr/bin/env tsx
/**
 * S292 — Identity-extraction input-window corpus harness (READ-ONLY).
 *
 * Measures how the input-selection policy of extractPlanIdentifiersWithHaiku
 * (src/lib/plan/extraction-dedup.ts) affects plan-identifier extraction across
 * a real DEV corpus. Motivated by DEV doc 534eea3c-a156-4018-81cf-234bec93b4db
 * (PacificSource SBC) whose federal header sits at OCR offset ~3171 — beyond
 * the historical slice(0, 2000) — so planName/planYear/planType extracted null
 * and the plan linked to no canonical.
 *
 * MODES
 *   --recon               fetch + cache corpus, derive model-free ground truth
 *                         (header offsets, carrier hits, sponsor/PEO hits),
 *                         report blast radius. NO model calls.
 *   --before              run the LIVE extractPlanIdentifiersWithHaiku (current
 *                         code) over the corpus → before.json
 *   --policy A|B|C|D      run a simulated window policy via a prompt-identical
 *                         replica call → policy-<X>.json
 *                           A = slice(0, 2000)   (historical behavior)
 *                           B = slice(0, 8000)
 *                           C = slice(0, 100000) (services-path ceiling)
 *                           D = head 1500 + ~2500 anchored on first federal
 *                               header marker beyond the head; wide fallback
 *   --after               run the LIVE extractor again (patched code) → after.json
 *   --diff <a.json> <b.json>   field-level diff of two result files
 *
 * OPTIONS
 *   --limit N             corpus cap (default 60)
 *   --out DIR             output dir (default $TMPDIR/s292-identity-corpus)
 *   --doc <uuid>          restrict to a single document id
 *
 * SAFETY: every Supabase call in this file is a SELECT. No writes, ever.
 * The corpus (including OCR text) is cached to <out>/corpus-cache.json on
 * first fetch and reused afterward so all runs measure identical inputs.
 *
 * Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * ANTHROPIC_API_KEY (model runs only).
 */

import { config } from "dotenv";
import { resolve, join } from "path";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { parseHaikuJSON } from "../src/lib/parser/safe-json";
import {
  extractPlanIdentifiersWithHaiku,
  type PlanIdentifiers,
} from "../src/lib/plan/extraction-dedup";

config({ path: resolve(__dirname, "..", ".env.local"), override: true });

// ── CLI ────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const LIMIT = parseInt(opt("limit") ?? "60", 10);
const OUT_DIR = opt("out") ?? join(tmpdir(), "s292-identity-corpus");
const ONLY_DOC = opt("doc");
const CONCURRENCY = 3;

mkdirSync(OUT_DIR, { recursive: true });

// ── Corpus types ───────────────────────────────────────────────────────────────

interface CorpusDoc {
  id: string;
  fileName: string;
  docType: string;
  status: string;
  ocrText: string;
  ocrLen: number;
  linkedInsurerName: string | null; // reference signal from linked insurance_plans
}

interface GroundTruth {
  docId: string;
  fileName: string;
  docType: string;
  ocrLen: number;
  /** First offset of "Coverage Period" (case-insensitive), or null. */
  coveragePeriodOffset: number | null;
  /** First offset of "Summary of Benefits and Coverage", or null. */
  sbcTitleOffset: number | null;
  /** min(non-null offsets above) — the federal SBC header anchor. */
  headerOffset: number | null;
  headerBeyond2000: boolean;
  headerBeyond8000: boolean;
  /** Carrier names detected anywhere in the OCR (reference, not oracle). */
  carrierHits: { name: string; offset: number }[];
  /** Sponsor/PEO markers detected (insurer-corruption risk signal). */
  sponsorHits: { marker: string; offset: number }[];
  /** Filename-derived plan-name phrase found verbatim in OCR, if any. */
  filenamePhraseInOcr: { phrase: string; offset: number } | null;
  linkedInsurerName: string | null;
}

interface RunResult {
  docId: string;
  fileName: string;
  inputChars: number;
  latencyMs: number;
  error: string | null;
  output: {
    insurer: string | null;
    planName: string | null;
    groupNumber: string | null;
    planYear: number | null;
    planType: string | null;
    state: string | null;
  };
}

interface RunFile {
  runLabel: string;
  timestamp: string;
  model: string;
  results: RunResult[];
}

// ── Model-free ground truth ────────────────────────────────────────────────────

// Reference carrier list for MEASUREMENT ONLY (this script never ships to prod;
// product code stays carrier-agnostic). Includes the majors from
// extraction-dedup INSURER_PATTERNS plus regional carriers seen in DEV.
const CARRIER_PATTERNS: [RegExp, string][] = [
  [/pacificsource/i, "PacificSource"],
  [/providence/i, "Providence"],
  [/moda\s*health|modahealth/i, "Moda Health"],
  [/regence/i, "Regence"],
  [/premera/i, "Premera"],
  [/cigna/i, "Cigna"],
  [/united\s*health/i, "UnitedHealthcare"],
  [/anthem/i, "Anthem"],
  [/aetna/i, "Aetna"],
  [/humana/i, "Humana"],
  [/kaiser/i, "Kaiser Permanente"],
  [/blue\s*shield/i, "Blue Shield"],
  [/blue\s*cross/i, "Blue Cross"],
  [/\bbcbs\b/i, "BCBS"],
  [/molina/i, "Molina Healthcare"],
  [/oscar\s*health|oscar\s*insurance/i, "Oscar Health"],
  [/ambetter/i, "Ambetter"],
  [/wellcare/i, "WellCare"],
  [/centene/i, "Centene"],
  [/highmark/i, "Highmark"],
  [/carefirst/i, "CareFirst"],
  [/florida\s*blue/i, "Florida Blue"],
  [/horizon\s*(bcbs|blue)/i, "Horizon BCBS"],
  [/health\s*net/i, "Health Net"],
  [/selecthealth/i, "SelectHealth"],
  [/emblemhealth/i, "EmblemHealth"],
  [/harvard\s*pilgrim/i, "Harvard Pilgrim"],
  [/geisinger/i, "Geisinger"],
  [/upmc/i, "UPMC"],
  [/priority\s*health/i, "Priority Health"],
];

const SPONSOR_MARKERS: RegExp[] = [
  /POLICYHOLDER\s*:/i,
  /Plan\s+Sponsor\s*:/i,
  /Plan\s+Administrator\s*:/i,
  /Employer\s+Group\s*:/i,
  /Sequoia\s+One/i,
  /TriNet/i,
  /Insperity/i,
  /ADP\s+TotalSource/i,
  /Justworks/i,
  /\bPEO\b/,
];

const FILENAME_STOPWORDS = new Set([
  "sbc", "eoc", "plan", "document", "doc", "pdf", "final", "copy", "the",
  "of", "and", "benefits", "coverage", "summary", "2023", "2024", "2025",
  "2026", "v1", "v2", "en", "english",
]);

// STRICT federal-header patterns. The loose forms ("coverage period",
// "Summary of Benefits and Coverage (SBC)") appear in the glossary boilerplate
// that federal-layout SBCs OPEN with — e.g. DEV doc 534eea3c has the prose
// mention at offset ~4 and the real header at 3171. Only the date-bearing
// "Coverage Period: MM/DD/YYYY" line and the "…Coverage: What this Plan
// Covers" title line identify the actual header block.
const HEADER_COVERAGE_PERIOD = /coverage\s+period\s*:?\s*\d{1,2}\/\d{1,2}\/\d{2,4}/i;
const HEADER_SBC_TITLE = /summary\s+of\s+benefits\s+and\s+coverage\s*:\s*what/i;

function deriveGroundTruth(doc: CorpusDoc): GroundTruth {
  const text = doc.ocrText;
  const cpMatch = HEADER_COVERAGE_PERIOD.exec(text);
  const sbcMatch = HEADER_SBC_TITLE.exec(text);
  const offsets = [cpMatch?.index, sbcMatch?.index].filter(
    (n): n is number => typeof n === "number",
  );
  const headerOffset = offsets.length > 0 ? Math.min(...offsets) : null;

  const carrierHits: { name: string; offset: number }[] = [];
  for (const [re, name] of CARRIER_PATTERNS) {
    const m = re.exec(text);
    if (m) carrierHits.push({ name, offset: m.index });
  }
  carrierHits.sort((a, b) => a.offset - b.offset);

  const sponsorHits: { marker: string; offset: number }[] = [];
  for (const re of SPONSOR_MARKERS) {
    const m = re.exec(text);
    if (m) sponsorHits.push({ marker: m[0], offset: m.index });
  }

  // Filename phrase: longest run of >=2 consecutive non-stopword tokens found
  // verbatim (case/whitespace-insensitive) in the OCR.
  let filenamePhraseInOcr: GroundTruth["filenamePhraseInOcr"] = null;
  const base = doc.fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[-_+.]+/g, " ");
  const tokens = base.split(/\s+/).filter(
    (t) => t.length >= 3 && !FILENAME_STOPWORDS.has(t.toLowerCase()),
  );
  for (let len = Math.min(tokens.length, 5); len >= 2 && !filenamePhraseInOcr; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      const phrase = tokens.slice(start, start + len).join(" ");
      const re = new RegExp(
        phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
        "i",
      );
      const m = re.exec(text);
      if (m) {
        filenamePhraseInOcr = { phrase, offset: m.index };
        break;
      }
    }
  }

  return {
    docId: doc.id,
    fileName: doc.fileName,
    docType: doc.docType,
    ocrLen: doc.ocrLen,
    coveragePeriodOffset: cpMatch?.index ?? null,
    sbcTitleOffset: sbcMatch?.index ?? null,
    headerOffset,
    headerBeyond2000: headerOffset !== null && headerOffset >= 2000,
    headerBeyond8000: headerOffset !== null && headerOffset >= 8000,
    carrierHits,
    sponsorHits,
    filenamePhraseInOcr,
    linkedInsurerName: doc.linkedInsurerName,
  };
}

// ── Window policies (measurement replicas) ─────────────────────────────────────

function windowA(text: string): string {
  return text.slice(0, 2000);
}
function windowB(text: string): string {
  return text.slice(0, 8000);
}
function windowC(text: string): string {
  return text.slice(0, 100_000);
}
function windowD(text: string): string {
  const HEAD = 1500;
  const head = text.slice(0, HEAD);
  // Anchor on the STRICT header forms only — the loose "coverage period"
  // phrase appears in glossary prose and would anchor into boilerplate.
  const marker = /coverage\s+period\s*:?\s*\d{1,2}\/\d{1,2}\/\d{2,4}|summary\s+of\s+benefits\s+and\s+coverage\s*:\s*what/gi;
  marker.lastIndex = HEAD;
  const m = marker.exec(text);
  if (m && m.index >= HEAD) {
    const start = Math.max(HEAD, m.index - 200);
    return `${head}\n[...]\n${text.slice(start, start + 2500)}`;
  }
  return text.slice(0, 8000); // no marker beyond head → wide fallback
}

const POLICIES: Record<string, (t: string) => string> = {
  A: windowA,
  B: windowB,
  C: windowC,
  D: windowD,
};

// ── Prompt-identical replica of extractPlanIdentifiersWithHaiku ───────────────
// The prompt body below is copied VERBATIM from src/lib/plan/extraction-dedup.ts
// so that only the input window differs between policies. If the live prompt
// changes, re-copy it.

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

async function callIdentityReplica(windowText: string): Promise<RunResult["output"]> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    timeout: 15000, // live parity — the real extractor uses 15s
    maxRetries: 1,
  });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    temperature: 0,
    messages: [{
      role: "user",
      content: `Extract the insurance plan identifiers from this document header. Return ONLY a JSON object with these fields (use null if not found):
{"insurer": "company name", "planName": "plan name", "groupNumber": "group #", "planYear": 2025, "planType": "HMO/PPO/etc", "state": "XX"}

IMPORTANT — insurer vs sponsor disambiguation:
- "insurer" must be the actual insurance CARRIER (e.g., Cigna, Aetna, Blue Shield, Kaiser, Anthem, UnitedHealthcare, Humana, BCBS).
- Do NOT use values labeled "POLICYHOLDER:", "Plan Sponsor:", "Plan Administrator:", "Employer Group:", or "Group:" — those identify the EMPLOYER / PEO / union / trust, NOT the insurance carrier (e.g., "Sequoia One PEO, LLC", "TriNet HR Corporation", "Insperity Group Plan", "ADP TotalSource" are PEOs, not insurers).
- The carrier is typically named on the cover or adjacent to phrases like "is offered by", "issued by", "administered by", or "underwritten by" (e.g., "Cigna Health and Life Insurance Company").
- If the document only names a sponsor/employer and no carrier is visible in this header text, set insurer to null.

Document text:
${windowText}`,
    }],
  });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const parsed = parseHaikuJSON<Record<string, unknown>>(text);
  return {
    insurer: (parsed.insurer as string) || null,
    planName: (parsed.planName as string) || null,
    groupNumber: (parsed.groupNumber as string) || null,
    planYear: typeof parsed.planYear === "number" ? parsed.planYear : null,
    planType: (parsed.planType as string) || null,
    state: (parsed.state as string) || null,
  };
}

// ── Corpus fetch + cache ───────────────────────────────────────────────────────

const CACHE_PATH = join(OUT_DIR, "corpus-cache.json");

async function fetchCorpus(): Promise<CorpusDoc[]> {
  if (existsSync(CACHE_PATH)) {
    const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CorpusDoc[];
    console.log(`[corpus] loaded ${cached.length} docs from cache ${CACHE_PATH}`);
    return ONLY_DOC ? cached.filter((d) => d.id === ONLY_DOC) : cached;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  if (!url.includes("wdpk")) {
    console.error(`Refusing to run: Supabase URL is not the DEV project (wdpk…). Got: ${url}`);
    process.exit(1);
  }
  const supabase = createClient(url, key);

  // READ-ONLY: select candidate documents. Paged to keep payloads sane.
  const { data: rows, error } = await supabase
    .from("documents")
    .select("id, file_name, doc_type, status, file_hash, processing_ocr_text, linked_insurance_plan_id")
    .not("processing_ocr_text", "is", null)
    .in("doc_type", ["sbc", "plan_document", "eoc"])
    .order("id", { ascending: true })
    .limit(400);
  if (error) {
    console.error("[corpus] documents select error:", error);
    process.exit(1);
  }

  // Dedupe by file_hash AND by sha256(ocrText) — byte-identical docs add no signal.
  const seen = new Set<string>();
  const docs: CorpusDoc[] = [];
  const planIds = new Set<string>();
  for (const r of rows ?? []) {
    const ocr = (r.processing_ocr_text as string) ?? "";
    if (ocr.length === 0) continue;
    const hashKey = (r.file_hash as string | null)
      ?? createHash("sha256").update(ocr).digest("hex");
    const ocrKey = createHash("sha256").update(ocr).digest("hex");
    if (seen.has(hashKey) || seen.has(ocrKey)) continue;
    seen.add(hashKey);
    seen.add(ocrKey);
    docs.push({
      id: r.id as string,
      fileName: (r.file_name as string) ?? "",
      docType: (r.doc_type as string) ?? "",
      status: (r.status as string) ?? "",
      ocrText: ocr,
      ocrLen: ocr.length,
      linkedInsurerName: null,
    });
    if (r.linked_insurance_plan_id) planIds.add(r.linked_insurance_plan_id as string);
    if (docs.length >= LIMIT) break;
  }

  // Reference signal: insurer_name from linked insurance_plans (READ-ONLY).
  if (planIds.size > 0) {
    const { data: plans, error: pErr } = await supabase
      .from("insurance_plans")
      .select("id, insurer_name")
      .in("id", [...planIds]);
    if (pErr) console.warn("[corpus] insurance_plans select error (non-fatal):", pErr);
    const byId = new Map((plans ?? []).map((p) => [p.id as string, p.insurer_name as string | null]));
    // Re-select linkage per doc (rows already fetched above).
    for (const r of rows ?? []) {
      const doc = docs.find((d) => d.id === r.id);
      if (doc && r.linked_insurance_plan_id) {
        doc.linkedInsurerName = byId.get(r.linked_insurance_plan_id as string) ?? null;
      }
    }
  }

  writeFileSync(CACHE_PATH, JSON.stringify(docs));
  console.log(`[corpus] fetched ${docs.length} unique docs → cached at ${CACHE_PATH}`);
  return ONLY_DOC ? docs.filter((d) => d.id === ONLY_DOC) : docs;
}

// ── Runners ────────────────────────────────────────────────────────────────────

async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

async function runLive(docs: CorpusDoc[], label: string): Promise<RunFile> {
  const results = await mapPool(docs, CONCURRENCY, async (doc): Promise<RunResult> => {
    const t0 = Date.now();
    let error: string | null = null;
    let out: PlanIdentifiers = {
      insurer: null, planName: null, groupNumber: null,
      planYear: null, planType: null, state: null, source: "haiku_fallback",
    };
    try {
      out = await extractPlanIdentifiersWithHaiku(doc.ocrText);
    } catch (e) {
      error = String(e);
    }
    const latencyMs = Date.now() - t0;
    console.log(`[${label}] ${doc.id.slice(0, 8)} ${latencyMs}ms insurer=${out.insurer} planName=${out.planName}`);
    return {
      docId: doc.id,
      fileName: doc.fileName,
      inputChars: doc.ocrLen, // live fn receives full text; its internal window decides
      latencyMs,
      error,
      output: {
        insurer: out.insurer, planName: out.planName, groupNumber: out.groupNumber,
        planYear: out.planYear, planType: out.planType, state: out.state,
      },
    };
  });
  return { runLabel: label, timestamp: new Date().toISOString(), model: HAIKU_MODEL, results };
}

async function runPolicy(docs: CorpusDoc[], policy: string): Promise<RunFile> {
  const windowFn = POLICIES[policy];
  if (!windowFn) {
    console.error(`Unknown policy ${policy}. Use A|B|C|D.`);
    process.exit(1);
  }
  const results = await mapPool(docs, CONCURRENCY, async (doc): Promise<RunResult> => {
    const windowText = windowFn(doc.ocrText);
    const t0 = Date.now();
    let error: string | null = null;
    let output: RunResult["output"] = {
      insurer: null, planName: null, groupNumber: null,
      planYear: null, planType: null, state: null,
    };
    try {
      output = await callIdentityReplica(windowText);
    } catch (e) {
      error = String(e);
    }
    const latencyMs = Date.now() - t0;
    console.log(`[policy-${policy}] ${doc.id.slice(0, 8)} in=${windowText.length}ch ${latencyMs}ms insurer=${output.insurer} planName=${output.planName}`);
    return {
      docId: doc.id,
      fileName: doc.fileName,
      inputChars: windowText.length,
      latencyMs,
      error,
      output,
    };
  });
  return {
    runLabel: `policy-${policy}`,
    timestamp: new Date().toISOString(),
    model: HAIKU_MODEL,
    results,
  };
}

// ── Diff ───────────────────────────────────────────────────────────────────────

const FIELDS = ["insurer", "planName", "planYear", "planType", "groupNumber", "state"] as const;

function diffRuns(aPath: string, bPath: string): void {
  const a = JSON.parse(readFileSync(aPath, "utf8")) as RunFile;
  const b = JSON.parse(readFileSync(bPath, "utf8")) as RunFile;
  const bById = new Map(b.results.map((r) => [r.docId, r]));
  let newlyFilled = 0, changed = 0, lost = 0, same = 0;
  for (const ra of a.results) {
    const rb = bById.get(ra.docId);
    if (!rb) continue;
    for (const f of FIELDS) {
      const va = ra.output[f];
      const vb = rb.output[f];
      if (va === vb || (va == null && vb == null)) { same++; continue; }
      if (va == null && vb != null) {
        newlyFilled++;
        console.log(`FILLED  ${ra.docId.slice(0, 8)} ${f}: null → ${JSON.stringify(vb)}  (${ra.fileName})`);
      } else if (va != null && vb == null) {
        lost++;
        console.log(`LOST    ${ra.docId.slice(0, 8)} ${f}: ${JSON.stringify(va)} → null  (${ra.fileName})`);
      } else {
        changed++;
        console.log(`CHANGED ${ra.docId.slice(0, 8)} ${f}: ${JSON.stringify(va)} → ${JSON.stringify(vb)}  (${ra.fileName})`);
      }
    }
  }
  console.log(`\n[diff ${a.runLabel} → ${b.runLabel}] filled=${newlyFilled} changed=${changed} LOST=${lost} unchanged=${same}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (flag("diff")) {
    const i = args.indexOf("--diff");
    diffRuns(args[i + 1], args[i + 2]);
    return;
  }

  const docs = await fetchCorpus();
  if (docs.length === 0) {
    console.error("No corpus documents matched.");
    process.exit(1);
  }

  // Ground truth is model-free and cheap — recompute on every invocation.
  const gts = docs.map(deriveGroundTruth);
  writeFileSync(join(OUT_DIR, "corpus-meta.json"), JSON.stringify(gts, null, 2));

  if (flag("recon")) {
    console.log(`\n=== RECON (${docs.length} docs) ===`);
    for (const gt of gts) {
      console.log(
        [
          gt.docId.slice(0, 8),
          gt.docType.padEnd(13),
          String(gt.ocrLen).padStart(7),
          `hdr=${gt.headerOffset ?? "none"}`.padEnd(11),
          gt.headerBeyond2000 ? ">2K!" : "    ",
          `carriers=[${gt.carrierHits.slice(0, 3).map((c) => `${c.name}@${c.offset}`).join(",")}]`,
          gt.sponsorHits.length > 0 ? `SPONSOR=[${gt.sponsorHits.map((s) => s.marker).join(",")}]` : "",
          gt.fileName.slice(0, 48),
        ].join(" "),
      );
    }
    const beyond2k = gts.filter((g) => g.headerBeyond2000);
    const beyond8k = gts.filter((g) => g.headerBeyond8000);
    const noHeader = gts.filter((g) => g.headerOffset === null);
    const withSponsor = gts.filter((g) => g.sponsorHits.length > 0);
    console.log(`\nBLAST RADIUS: ${beyond2k.length}/${gts.length} docs have federal header beyond 2,000 chars`);
    console.log(`              ${beyond8k.length}/${gts.length} beyond 8,000 chars`);
    console.log(`              ${noHeader.length}/${gts.length} have no federal header marker at all`);
    console.log(`              ${withSponsor.length}/${gts.length} contain sponsor/PEO markers (insurer-corruption risk)`);
    for (const g of beyond2k) console.log(`  >2K: ${g.docId} hdr@${g.headerOffset} ${g.fileName}`);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.length < 10) {
    console.error("ANTHROPIC_API_KEY missing/empty — model runs unavailable.");
    process.exit(1);
  }

  let run: RunFile | null = null;
  let outName = "";
  if (flag("before")) {
    run = await runLive(docs, "before-live-current");
    outName = "before.json";
  } else if (flag("after")) {
    run = await runLive(docs, "after-live-patched");
    outName = "after.json";
  } else if (opt("policy")) {
    const p = opt("policy")!.toUpperCase();
    run = await runPolicy(docs, p);
    outName = `policy-${p}.json`;
  } else {
    console.error("Pick a mode: --recon | --before | --policy A|B|C|D | --after | --diff a b");
    process.exit(1);
  }

  const outPath = join(OUT_DIR, outName);
  writeFileSync(outPath, JSON.stringify(run, null, 2));
  const errs = run!.results.filter((r) => r.error).length;
  const fillCounts = FIELDS.map(
    (f) => `${f}=${run!.results.filter((r) => r.output[f] != null).length}`,
  ).join(" ");
  const avgLatency = Math.round(
    run!.results.reduce((s, r) => s + r.latencyMs, 0) / run!.results.length,
  );
  const avgChars = Math.round(
    run!.results.reduce((s, r) => s + r.inputChars, 0) / run!.results.length,
  );
  console.log(`\n[${run!.runLabel}] ${run!.results.length} docs, ${errs} errors, avgLatency=${avgLatency}ms, avgInputChars=${avgChars}`);
  console.log(`fill: ${fillCounts}`);
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
