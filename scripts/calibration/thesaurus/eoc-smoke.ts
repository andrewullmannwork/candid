/* EOC smoke v2 — the Session-A/T5 corpus runner (S187). NON-MUTATING. COMMIT AT T6.
 *
 * Runs the REAL parseEOC (real Haiku) over one or more EOC layout texts, N independent runs per
 * (doc, prompt-mode), with bounded DOC-level concurrency, and persists one criteria-JSON artifact
 * per (doc, mode, run) for resume-on-failure + offline re-analysis (T5 Tier-1 riders). N runs stay
 * N INDEPENDENT parses — prompt caching reuses prefix COMPUTATION, never responses; the snapshot
 * replay layer (a response cache) is hard-asserted OFF below.
 *
 * Per-run observations (also in the artifact): Section-A prior-auth funnel, Section-B slug
 * classification (valid/rescued/unknown — 0-invention gate), the accumulate-lossless merge
 * re-check (drives the SHIPPED mergeClinicalMnFragments over saved criteria; target 0 lost),
 * cost-guard trip detection (chunk_skipped_near_cost_cap), wall-clock, and token/cost telemetry
 * (recorded + corrected-rate; cache split populated once the parser threads cache fields).
 *
 *   npx tsx scripts/calibration/thesaurus/eoc-smoke.ts <file-or-dir ...> \
 *     [--runs N] [--mode off|on|both] [--concurrency D] [--stagger-ms MS] \
 *     [--out DIR] [--chunk-concurrency K] [--skip-plan-identity] [--skip-aca] \
 *     [--sections <csv-of-EOCSectionHint>] [--no-rate-probe]
 *
 * Defaults: --runs 1 --mode off --concurrency 1 --stagger-ms 20000
 *           --out <vault>/plans/findings/eoc-pad-2026-06-10/runs
 * Resume: a (doc, mode, run) with an existing VALID artifact (complete:true) is skipped.
 *
 * S190 sections-only runs (--sections medical_necessity --skip-aca --skip-plan-identity): the
 * T5-lite/T5 instrument — only the named sections dispatch. Artifacts record sectionFilter +
 * skipAca + the FULL vocab-block SHA-256 (schema eoc-smoke-v2/2): N-pooling across runs is
 * valid ONLY between artifacts with equal vocabSha256 AND equal sectionFilter (the goldens pin
 * instruction bytes, NOT the DB-rendered vocab block; vocabFirstLine alone is weak identity).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { loadCalibEnv } from "../../lib/calib-env";
const env = loadCalibEnv([]);
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { parseEOC } from "@/lib/eoc/parser";
import { buildMedicalNecessityPrompt } from "@/lib/eoc/haiku-prompts/medical-necessity";
import type { EOCSectionHint, MedicalNecessityCriterion } from "@/lib/eoc/types";
import { mergeClinicalMnFragments, resolveServiceIdBySlug } from "@/lib/plan/coverage-targeting";
import { resolveServices, type ResolveLineInput } from "@/lib/claims/service-resolver";
import { acceptCodeAnchoredSlug, canonicalizeSlug, loadServiceRenameMap } from "@/lib/plan_doc/thesaurus-routing";
import { loadValidServiceSlugs, loadServiceVocabularyBlock } from "@/lib/parser/service-catalog-slugs";

// ---------------------------------------------------------------- env guards
// Snapshot REPLAY would serve identical stale responses ($0) and silently destroy N-run
// de-noising independence + falsify the cache-engagement proof; RECORD would write a
// pre/post-padding mixed snapshot set. Both are hard failures for calibration runs.
for (const k of ["HAIKU_SNAPSHOT_REPLAY", "HAIKU_SNAPSHOT_RECORD"] as const) {
  if (process.env[k] === "true") {
    console.error(`FATAL: ${k}=true — snapshot layer must be OFF for eval runs.`);
    process.exit(2);
  }
}
if (process.env.EOC_SELF_CHECK_ENABLED === "true") {
  console.error("FATAL: EOC_SELF_CHECK_ENABLED=true — self-check skews per-parse cost/latency; unset it for eval runs.");
  process.exit(2);
}

// ---------------------------------------------------------------- CLI
interface Cli {
  inputs: string[];
  runs: number;
  mode: "off" | "on" | "both";
  concurrency: number;
  staggerMs: number;
  out: string;
  chunkConcurrency: number | null;
  skipPlanIdentity: boolean;
  skipAca: boolean;
  sections: EOCSectionHint[] | null;
  rateProbe: boolean;
}
// The 6 dispatchable hints (parser SECTION_CONFIGS keys; the other EOCSectionHint members are
// DO_NOT_EXTRACT/other markers). Typed against the exported union so a hint rename breaks tsc here.
const DISPATCHABLE_SECTIONS: (EOCSectionHint | "prior_auth_prose")[] = [
  // S193 D-P2-4: prior_auth_prose is the prose-PA leg's FILTER KEY (not a region hint) — it
  // dispatches the MN extractor over the prior_auth_codes REGION while Section A stays filterable.
  "prior_auth_prose",
  "prior_auth_codes",
  "medical_necessity",
  "appeals_procedures",
  "cob_rules",
  "eligibility_rules",
  "definitions",
];
function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    inputs: [],
    runs: 1,
    mode: "off",
    concurrency: 1,
    staggerMs: 20000,
    out: "/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/eoc-pad-2026-06-10/runs",
    chunkConcurrency: null,
    skipPlanIdentity: false,
    skipAca: false,
    sections: null,
    rateProbe: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") cli.runs = Number(argv[++i]);
    else if (a === "--mode") cli.mode = argv[++i] as Cli["mode"];
    else if (a === "--concurrency") cli.concurrency = Number(argv[++i]);
    else if (a === "--stagger-ms") cli.staggerMs = Number(argv[++i]);
    else if (a === "--out") cli.out = argv[++i];
    else if (a === "--chunk-concurrency") cli.chunkConcurrency = Number(argv[++i]);
    else if (a === "--skip-plan-identity") cli.skipPlanIdentity = true;
    else if (a === "--skip-aca") cli.skipAca = true;
    else if (a === "--sections") cli.sections = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean) as EOCSectionHint[];
    else if (a === "--no-rate-probe") cli.rateProbe = false;
    else cli.inputs.push(a);
  }
  if (!["off", "on", "both"].includes(cli.mode)) throw new Error(`bad --mode ${cli.mode}`);
  if (!Number.isFinite(cli.runs) || cli.runs < 1) throw new Error("bad --runs");
  if (!Number.isFinite(cli.concurrency) || cli.concurrency < 1) throw new Error("bad --concurrency");
  if (cli.sections) {
    if (cli.sections.length === 0) throw new Error("--sections: empty list");
    for (const s of cli.sections) {
      if (!DISPATCHABLE_SECTIONS.includes(s as EOCSectionHint | "prior_auth_prose")) throw new Error(`--sections: unknown section "${s}" (valid: ${DISPATCHABLE_SECTIONS.join(",")})`);
    }
  }
  if (cli.inputs.length === 0) throw new Error("no input files/dirs given");
  return cli;
}

function expandInputs(inputs: string[]): string[] {
  const files: string[] = [];
  for (const p of inputs) {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p).filter((f) => f.endsWith(".txt")).sort()) files.push(path.join(p, f));
    } else files.push(p);
  }
  return files;
}

// Corpus carrier map (roadmap §0.4; cigna.txt is the on-disk name for "Cigna Plan Benefits").
const CARRIER: Record<string, string> = {
  "ecm-3": "Kaiser", "ecm-4": "Kaiser", "ecm-7": "Kaiser", "ecm-11": "Kaiser",
  "ecm-5": "Blue Shield", "ecm-12": "Blue Shield", "ecm-13": "Blue Shield",
  "ecm-15": "Blue Shield", "ecm-16": "Blue Shield", "ecm-18": "Blue Shield",
  "ecm-14": "Anthem", "ecm-17": "Anthem", "ecm-19": "Anthem",
  "cigna": "Cigna",
};

// ---------------------------------------------------------------- pricing (published Haiku 4.5)
// The shared client's recorded costUsd uses stale constants ($0.80/$4.00/1M, cached read $0.08);
// corrected math uses published rates. While cache tokens are zero (pre-pad), corrected ==
// recorded x1.25 exactly (both rates scale by 1.25). Once the parser threads the cache split
// (total_cache_*_tokens), the exact corrected formula below applies.
const RATE = { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 }; // $/MTok

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number | null;
  cacheReadTokens: number | null;
  recordedCostUsd: number;
  correctedCostUsd: number;
}

interface RunArtifact {
  /** v2/2 (S190): + options.sectionFilter/skipAca/vocabSha256 — sections-only artifacts are
   *  forever distinguishable from full-parse ones; pool N only on equal vocabSha256+sectionFilter. */
  schema: "eoc-smoke-v2/2";
  complete: boolean;
  doc: string;
  file: string;
  carrier: string;
  mode: "off" | "on";
  run: number;
  startedAt: string;
  wallMs: number;
  options: {
    chunkConcurrency: number | null;
    skipPlanIdentity: boolean;
    skipAca: boolean;
    sectionFilter: EOCSectionHint[] | null;
    promptPadded: boolean;
    vocabFirstLine: string;
    /** SHA-256 of the FULL DB-rendered vocab block (goldens pin instruction bytes only). */
    vocabSha256: string;
  };
  segmentationUsed: string | null;
  /** S187 leg-separated wall-clock from parseEOC (null on pre-S187 artifacts). */
  timings: Record<string, number> | null;
  warnings: string[];
  costGuardTripped: boolean;
  usage: Usage;
  sectionA: {
    codesExtracted: number;
    withCode: number;
    conceptResolved: number;
    rescueResolved: number;
    noSlug: number;
    acceptedSample: string[];
  };
  sectionB: {
    criteriaExtracted: number;
    withHint: number;
    noHint: number;
    validDirect: number;
    rescuedRename: number;
    unknown: number;
    unknownSample: string[];
  };
  accumulateCheck: { multiPassageSlugs: number; lostTexts: number; scalarFirstViolations: number };
  /** Plan-identity scalars — the before/after gate for the plan-doc-leg padding (field-level diff). */
  planIdentity: unknown;
  parseErrors: unknown[];
  criteria: MedicalNecessityCriterion[];
  priorAuthCodes: unknown[];
}

// ---------------------------------------------------------------- shared lookups
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
  auth: { persistSession: false },
});
const CALIB_USER = "2ce55772-bdf1-4edd-bd16-215aa239990e";
const norm = (s: string): string => (s ?? "").replace(/\s+/g, " ").trim();

async function findConceptRO(code: string, type: string): Promise<string | null> {
  const { data } = await sb.from("concepts").select("id").eq("vocabulary_id", type).eq("concept_code", code).limit(1).maybeSingle();
  if (!data) return null;
  const { data: svc } = await sb.from("service_catalog").select("slug").eq("slug", code.toLowerCase()).limit(1).maybeSingle();
  return (svc?.slug as string) ?? null;
}

const serviceIdCache = new Map<string, boolean>();
async function hasServiceId(slug: string): Promise<boolean> {
  if (!serviceIdCache.has(slug)) serviceIdCache.set(slug, Boolean(await resolveServiceIdBySlug(sb, slug)));
  return serviceIdCache.get(slug) as boolean;
}

// ---------------------------------------------------------------- per-run analysis
async function analyzeSectionA(
  codes: Array<{ billing_code?: string | null; billing_code_type?: string | null; pa_criteria?: string | null }>,
  renameMap: Map<string, string>,
): Promise<RunArtifact["sectionA"]> {
  let withCode = 0, conceptResolved = 0, rescueResolved = 0, noSlug = 0;
  const accepted: string[] = [];
  const rescueCandidates: Array<{ i: number; code: string; type: string; crit: string | null }> = [];
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (!c.billing_code || !c.billing_code_type) { noSlug++; continue; }
    withCode++;
    const slug = await findConceptRO(c.billing_code, c.billing_code_type);
    if (slug) {
      conceptResolved++;
      const s = canonicalizeSlug(slug, renameMap);
      accepted.push(`${c.billing_code}->${s}(concept,id=${(await hasServiceId(s)) ? "ok" : "NO_ID"})`);
    } else rescueCandidates.push({ i, code: c.billing_code, type: c.billing_code_type, crit: c.pa_criteria ?? null });
  }
  if (rescueCandidates.length > 0) {
    const lines: ResolveLineInput[] = rescueCandidates.map((r) => ({ lineNumber: r.i, description: r.crit ?? "", billingCode: r.code, billingCodeType: r.type }));
    const resolved = await resolveServices(lines, { supabase: sb, userId: CALIB_USER, skipHaiku: true, skipWriteback: true });
    for (const r of rescueCandidates) {
      const slug = acceptCodeAnchoredSlug(resolved.get(r.i));
      if (slug) {
        rescueResolved++;
        const s = canonicalizeSlug(slug, renameMap);
        accepted.push(`${r.code}->${s}(rescue,id=${(await hasServiceId(s)) ? "ok" : "NO_ID"})`);
      } else noSlug++;
    }
  }
  return { codesExtracted: codes.length, withCode, conceptResolved, rescueResolved, noSlug, acceptedSample: accepted.slice(0, 12) };
}

function analyzeSectionB(
  criteria: MedicalNecessityCriterion[],
  renameMap: Map<string, string>,
  validSlugs: Set<string>,
): RunArtifact["sectionB"] {
  let withHint = 0, noHint = 0, validDirect = 0, rescuedRename = 0, unknown = 0;
  const unknownSample: string[] = [];
  for (const cr of criteria) {
    if (!cr.service_slug_hint) { noHint++; continue; }
    withHint++;
    const canon = canonicalizeSlug(cr.service_slug_hint, renameMap);
    if (validSlugs.has(cr.service_slug_hint)) validDirect++;
    else if (validSlugs.has(canon)) rescuedRename++;
    else { unknown++; if (unknownSample.length < 12) unknownSample.push(cr.service_slug_hint); }
  }
  return { criteriaExtracted: criteria.length, withHint, noHint, validDirect, rescuedRename, unknown, unknownSample };
}

/** Flag-OFF persist surface + the SHIPPED merge — the accumulate-lossless rider (probe-v2 logic). */
function accumulateCheck(
  criteria: MedicalNecessityCriterion[],
  renameMap: Map<string, string>,
  validSlugs: Set<string>,
): RunArtifact["accumulateCheck"] {
  const bySlug = new Map<string, MedicalNecessityCriterion[]>();
  for (const cr of criteria) {
    if (!cr.service_slug_hint) continue;
    const canon = canonicalizeSlug(cr.service_slug_hint, renameMap);
    const key = validSlugs.has(cr.service_slug_hint) ? cr.service_slug_hint : validSlugs.has(canon) ? canon : null;
    if (!key) continue;
    bySlug.set(key, [...(bySlug.get(key) ?? []), cr]);
  }
  let lostTexts = 0, scalarFirstViolations = 0, multiPassageSlugs = 0;
  for (const [, crits] of bySlug) {
    if (crits.length > 1) multiPassageSlugs++;
    const merged = mergeClinicalMnFragments(crits);
    const entries = (merged?.coverageRules.medical_necessity_criteria ?? []) as Array<{ criteria_text: string }>;
    const retained = new Set(entries.map((e) => norm(e.criteria_text)));
    lostTexts += crits.filter((c) => !retained.has(norm(c.criteria_text))).length;
    if (crits.length > 1 && norm((merged?.coverageRules.medical_necessity_text as string) ?? "") !== norm(crits[0].criteria_text)) {
      scalarFirstViolations++;
    }
  }
  return { multiPassageSlugs, lostTexts, scalarFirstViolations };
}

// ---------------------------------------------------------------- one (doc, mode, run)
async function runOne(
  file: string,
  doc: string,
  mode: "off" | "on",
  run: number,
  cli: Cli,
  vocab: string,
  renameMap: Map<string, string>,
  validSlugs: Set<string>,
): Promise<RunArtifact> {
  const ocrText = fs.readFileSync(file, "utf8");
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const options: Parameters<typeof parseEOC>[1] = {
    documentId: `eoc-smoke-${doc}-${mode}-r${run}`,
    extractionMethod: "pdftotext",
    selectiveSelfCheckEnabled: false,
    serviceVocabulary: vocab,
    eocContentTypeRoutingOn: mode === "on",
  };
  // Options that land later this session (chunk pool / plan-identity skip): pass only when
  // requested, via a loose record so the harness runs against pre- and post-change trees.
  const loose = options as unknown as Record<string, unknown>;
  if (cli.chunkConcurrency !== null) {
    loose.chunkConcurrency = cli.chunkConcurrency;
    // Same K for the embedded plan-doc leg (explicit override = eval independence from DB config).
    loose.planDocChunkConcurrency = cli.chunkConcurrency;
  }
  if (cli.skipPlanIdentity) loose.skipPlanIdentity = true;
  if (cli.skipAca) loose.skipAca = true;
  if (cli.sections) loose.sectionFilter = cli.sections;

  const parsed = await parseEOC(ocrText, options);
  const wallMs = Date.now() - t0;

  const p = parsed as unknown as Record<string, unknown>;
  const sections = (p.sections ?? {}) as Record<string, { warnings?: string[]; data?: Record<string, unknown> } | undefined>;
  const warnings: string[] = [];
  for (const key of Object.keys(sections)) for (const w of sections[key]?.warnings ?? []) warnings.push(`${key}: ${w}`);
  for (const w of (p.warnings as string[] | undefined) ?? []) warnings.push(w);

  const inputTokens = Number(p.total_input_tokens ?? 0);
  const outputTokens = Number(p.total_output_tokens ?? 0);
  const cacheCreate = p.total_cache_create_tokens != null ? Number(p.total_cache_create_tokens) : null;
  const cacheRead = p.total_cache_read_tokens != null ? Number(p.total_cache_read_tokens) : null;
  const recordedCostUsd = Number(p.total_cost_usd ?? 0);
  const correctedCostUsd =
    cacheCreate != null && cacheRead != null
      ? ((inputTokens - cacheCreate - cacheRead) * RATE.input + cacheCreate * RATE.cacheWrite + cacheRead * RATE.cacheRead + outputTokens * RATE.output) / 1e6
      : recordedCostUsd * 1.25; // exact while cache classes are zero (stale constants are uniformly 0.8x)

  const criteria = (sections.medical_necessity?.data?.criteria ?? []) as MedicalNecessityCriterion[];
  const codes = (sections.prior_auth_codes?.data?.codes ?? []) as Array<{ billing_code?: string | null; billing_code_type?: string | null; pa_criteria?: string | null }>;

  return {
    schema: "eoc-smoke-v2/2",
    complete: true,
    doc,
    file,
    carrier: CARRIER[doc] ?? "unknown",
    mode,
    run,
    startedAt,
    wallMs,
    options: {
      chunkConcurrency: cli.chunkConcurrency,
      skipPlanIdentity: cli.skipPlanIdentity,
      skipAca: cli.skipAca,
      sectionFilter: cli.sections,
      promptPadded: buildMedicalNecessityPrompt("", false).startsWith("## CACHE PADDING"),
      vocabFirstLine: vocab ? vocab.split("\n")[0] : "EMPTY",
      vocabSha256: crypto.createHash("sha256").update(vocab ?? "").digest("hex"),
    },
    segmentationUsed: (p.segmentation_used as string | undefined) ?? null,
    timings: (p.timings as Record<string, number> | undefined) ?? null,
    warnings,
    costGuardTripped: warnings.some((w) => w.includes("chunk_skipped_near_cost_cap")),
    usage: { inputTokens, outputTokens, cacheCreateTokens: cacheCreate, cacheReadTokens: cacheRead, recordedCostUsd, correctedCostUsd },
    sectionA: await analyzeSectionA(codes, renameMap),
    sectionB: analyzeSectionB(criteria, renameMap, validSlugs),
    accumulateCheck: accumulateCheck(criteria, renameMap, validSlugs),
    planIdentity: p.plan_identity ?? null,
    parseErrors: (p.parse_errors as unknown[] | undefined) ?? [],
    criteria,
    priorAuthCodes: codes,
  };
}

// ---------------------------------------------------------------- rate-limit probe
async function rateProbe(): Promise<void> {
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
    const { response } = await client.messages
      .create({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "." }] })
      .withResponse();
    const h = (k: string): string => response.headers.get(k) ?? "?";
    console.log(
      `[rate-probe] requests/min=${h("anthropic-ratelimit-requests-limit")} input-tok/min=${h("anthropic-ratelimit-input-tokens-limit")} output-tok/min=${h("anthropic-ratelimit-output-tokens-limit")} (remaining: ${h("anthropic-ratelimit-requests-remaining")}/${h("anthropic-ratelimit-input-tokens-remaining")}/${h("anthropic-ratelimit-output-tokens-remaining")})`,
    );
  } catch (e) {
    console.warn(`[rate-probe] failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------- main
(async () => {
  const cli = parseCli(process.argv.slice(2));
  const files = expandInputs(cli.inputs);
  const modes: Array<"off" | "on"> = cli.mode === "both" ? ["off", "on"] : [cli.mode];
  fs.mkdirSync(cli.out, { recursive: true });

  console.log(`\n========== EOC SMOKE v2: ${files.length} doc(s) x ${modes.length} mode(s) x ${cli.runs} run(s) | doc-concurrency=${cli.concurrency} ==========`);
  if (cli.rateProbe) await rateProbe();

  const vocab = await loadServiceVocabularyBlock(sb);
  const renameMap = await loadServiceRenameMap(sb);
  const validSlugs = await loadValidServiceSlugs(sb);

  // Manifest (T5 Tier-2 joins artifacts to the GT worksheet by doc/carrier).
  const manifest = files.map((f) => ({ file: f, doc: path.basename(f, ".txt"), carrier: CARRIER[path.basename(f, ".txt")] ?? "unknown" }));
  fs.writeFileSync(path.join(cli.out, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), modes, runs: cli.runs, docs: manifest }, null, 2));

  const tasks = files.map((file, fi) => ({ file, fi, doc: path.basename(file, ".txt") }));
  const results: Array<{ doc: string; mode: string; run: number; status: string; wallMs: number; art?: RunArtifact }> = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const t = tasks[cursor++];
      if (!t) return;
      // Stagger doc starts so the first wave per section-prompt isn't all concurrent cold
      // cache-writes (a cache entry is readable only after the first response begins).
      if (cli.concurrency > 1 && cli.staggerMs > 0 && t.fi > 0) await new Promise((r) => setTimeout(r, cli.staggerMs));
      for (const mode of modes) {
        for (let run = 1; run <= cli.runs; run++) {
          const outFile = path.join(cli.out, `${t.doc}.${mode}.run${run}.json`);
          if (fs.existsSync(outFile)) {
            try {
              const prev = JSON.parse(fs.readFileSync(outFile, "utf8")) as RunArtifact;
              if (prev.complete) { results.push({ doc: t.doc, mode, run, status: "resumed-skip", wallMs: prev.wallMs, art: prev }); console.log(`[skip] ${t.doc}.${mode}.run${run} (valid artifact exists)`); continue; }
            } catch { /* invalid artifact -> re-run */ }
          }
          console.log(`[run ] ${t.doc}.${mode}.run${run} ...`);
          try {
            const art = await runOne(t.file, t.doc, mode, run, cli, vocab, renameMap, validSlugs);
            const tmp = `${outFile}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(art, null, 2));
            fs.renameSync(tmp, outFile);
            results.push({ doc: t.doc, mode, run, status: "ok", wallMs: art.wallMs, art });
            console.log(
              `[done] ${t.doc}.${mode}.run${run}: ${(art.wallMs / 1000).toFixed(0)}s | criteria=${art.sectionB.criteriaExtracted} (valid=${art.sectionB.validDirect} rescued=${art.sectionB.rescuedRename} unknown=${art.sectionB.unknown}) | PA codes=${art.sectionA.codesExtracted} | lost=${art.accumulateCheck.lostTexts} | $rec=${art.usage.recordedCostUsd.toFixed(3)} $corr=${art.usage.correctedCostUsd.toFixed(3)} | cache(cr/rd)=${art.usage.cacheCreateTokens ?? "n/a"}/${art.usage.cacheReadTokens ?? "n/a"}${art.costGuardTripped ? " | !! COST-GUARD TRIPPED" : ""}`,
            );
          } catch (e) {
            results.push({ doc: t.doc, mode, run, status: `FAILED: ${e instanceof Error ? e.message : String(e)}`, wallMs: 0 });
            console.error(`[FAIL] ${t.doc}.${mode}.run${run}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(cli.concurrency, tasks.length) }, () => worker()));

  // ---------------- summary
  console.log(`\n========== SUMMARY (${results.length} runs) ==========`);
  let failed = 0;
  for (const r of results) {
    if (!r.art) { failed++; console.log(`  ${r.doc}.${r.mode}.run${r.run}: ${r.status}`); continue; }
    const a = r.art;
    console.log(
      `  ${a.doc.padEnd(8)} ${a.mode.padEnd(3)} run${a.run}: ${(a.wallMs / 60000).toFixed(1)}min  criteria=${String(a.sectionB.criteriaExtracted).padStart(3)}  unknown=${a.sectionB.unknown}  lost=${a.accumulateCheck.lostTexts}  $corr=${a.usage.correctedCostUsd.toFixed(3)}  guardTrip=${a.costGuardTripped ? "YES" : "no"}  padded=${a.options.promptPadded ? "Y" : "N"}`,
    );
  }
  const totalCorr = results.reduce((n, r) => n + (r.art?.usage.correctedCostUsd ?? 0), 0);
  const totalLost = results.reduce((n, r) => n + (r.art?.accumulateCheck.lostTexts ?? 0), 0);
  console.log(`  TOTAL: $corr=${totalCorr.toFixed(2)} | lostTexts=${totalLost} (target 0) | failed=${failed}`);
  console.log(`  artifacts: ${cli.out}`);
  process.exit(failed > 0 ? 1 : 0);
})();
