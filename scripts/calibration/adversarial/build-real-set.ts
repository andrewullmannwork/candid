/**
 * Ing-G.2a — REAL-set sampler for the anti-AI-PDF training corpus.
 *
 * The "real" stratum is a diversity-maximized sample of the cold-start SBC PDFs that
 * landed in PROD as classified_type='plan_document' (the unified parser routes SBC+EOC
 * through the plan-doc path, so classified_type is NEVER literally 'SBC' — see S169 recon).
 * Cold-start docs are isolable by file_name = "<state>-<insurer>-<plan>-<year>.pdf"
 * (the seed_id; admin-seeded), with structured metadata in insurance_plans via
 * source_document_id.
 *
 * Two phases (never auto-download):
 *   --introspect  : query + print aggregate distribution + write a stratified SELECTION
 *                   (no PDF download). Inspect before pulling bytes.
 *   --download    : download the selected PDFs to _real_pdfs/ (gitignored, local-only).
 *
 * PII discipline: prints AGGREGATE counts + dataset seed_ids only (never user_id /
 * storage_path / raw content). Downloaded PDFs stay local (gitignored).
 *
 * Run:
 *   npx tsx scripts/calibration/adversarial/build-real-set.ts --introspect [--target 60]
 *   npx tsx scripts/calibration/adversarial/build-real-set.ts --download
 */
import { config } from "dotenv";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
config({ path: resolve(process.cwd(), ".env.local") });
import { createClient } from "@supabase/supabase-js";

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const DIR = resolve(process.cwd(), "scripts/calibration/adversarial");
const REAL_DIR = join(DIR, "_real_pdfs");
const SELECTION_PATH = join(REAL_DIR, "_selection.json");

type DocRow = { id: string; file_name: string; storage_path: string; file_hash: string | null; file_size: number; user_id: string; created_at: string };
type Cand = {
  seed_id: string; doc_id: string; file_hash: string | null; file_size: number; storage_path: string;
  state: string; year: number; insurer: string; plan_type: string | null;
};

async function fetchAllPlanDocs(): Promise<DocRow[]> {
  const out: DocRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from("documents")
      .select("id, file_name, storage_path, file_hash, file_size, user_id, created_at")
      .eq("classified_type", "plan_document")
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`documents fetch: ${error.message}`);
    out.push(...((data ?? []) as DocRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function joinInsurancePlans(docIds: string[]): Promise<Map<string, { insurer: string | null; plan_type: string | null; plan_year: number | null; state: string | null }>> {
  const m = new Map<string, { insurer: string | null; plan_type: string | null; plan_year: number | null; state: string | null }>();
  for (let i = 0; i < docIds.length; i += 200) {
    const batch = docIds.slice(i, i + 200);
    const { data } = await svc
      .from("insurance_plans")
      .select("source_document_id, insurer_name, plan_type, plan_year, state")
      .in("source_document_id", batch);
    const rows = (data ?? []) as Array<{ source_document_id: string | null; insurer_name: string | null; plan_type: string | null; plan_year: number | null; state: string | null }>;
    for (const r of rows) {
      const k = r.source_document_id;
      if (k && !m.has(k)) m.set(k, { insurer: r.insurer_name, plan_type: r.plan_type, plan_year: r.plan_year, state: r.state });
    }
  }
  return m;
}

function tally(rows: Cand[], key: (c: Cand) => string): [string, number][] {
  const t: Record<string, number> = {};
  for (const r of rows) { const k = key(r) || "(none)"; t[k] = (t[k] ?? 0) + 1; }
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
}

/** Round-robin across (insurer×state) buckets to maximize diversity (year ~constant in cold-start). */
function stratifiedSelect(cands: Cand[], target: number): Cand[] {
  const buckets = new Map<string, Cand[]>();
  for (const c of cands) {
    const k = `${c.insurer}|${c.state}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(c);
  }
  const order = [...buckets.keys()];
  const picked: Cand[] = [];
  const seenHash = new Set<string>();
  // Force-include rare non-2026 plan-years first (template-year diversity; closes caveat 3).
  for (const c of cands) {
    if (c.year && c.year !== 2026) {
      if (c.file_hash && seenHash.has(c.file_hash)) continue;
      if (c.file_hash) seenHash.add(c.file_hash);
      picked.push(c);
    }
  }
  let round = 0;
  while (picked.length < target) {
    let advanced = false;
    for (const k of order) {
      const b = buckets.get(k)!;
      if (round < b.length) {
        const c = b[round];
        if (c.file_hash && seenHash.has(c.file_hash)) continue;
        if (c.file_hash) seenHash.add(c.file_hash);
        picked.push(c);
        advanced = true;
        if (picked.length >= target) break;
      }
    }
    if (!advanced) break;
    round += 1;
  }
  return picked;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);

async function introspect(target: number) {
  const docs = await fetchAllPlanDocs();
  console.log(`fetched plan_document rows: ${docs.length}`);

  // Stratification source = insurance_plans via source_document_id (structured insurer/state/year).
  // Candidates = docs WITH a join row (clean metadata); dedup by file_hash. Excludes the handful of
  // generic test uploads ("sbc.pdf", "Cigna Plan Benefits.pdf") that lack a structured plan row.
  const join = await joinInsurancePlans(docs.map((d) => d.id));
  console.log(`docs with insurance_plans(source_document_id): ${join.size} / ${docs.length}`);

  const seenHash = new Set<string>();
  const cands: Cand[] = [];
  for (const d of docs) {
    const ip = join.get(d.id);
    if (!ip || !ip.insurer) continue; // require structured metadata
    if (d.file_hash && seenHash.has(d.file_hash)) continue;
    if (d.file_hash) seenHash.add(d.file_hash);
    const insurer = slug(ip.insurer);
    const state = (ip.state ?? "??").toString().toUpperCase();
    const docId8 = d.id.slice(0, 8);
    cands.push({
      seed_id: `${state}-${insurer}-${docId8}`, doc_id: d.id, file_hash: d.file_hash, file_size: d.file_size, storage_path: d.storage_path,
      state, year: ip.plan_year ?? 0, insurer, plan_type: ip.plan_type ?? null,
    });
  }
  console.log(`unique-by-hash candidates with metadata: ${cands.length}`);

  console.log(`\n--- by state ---`); for (const [k, n] of tally(cands, (c) => c.state)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log(`\n--- by year ---`); for (const [k, n] of tally(cands, (c) => String(c.year))) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log(`\n--- by plan_type ---`); for (const [k, n] of tally(cands, (c) => c.plan_type ?? "(null)")) console.log(`  ${String(n).padStart(4)}  ${k}`);
  const insurers = tally(cands, (c) => c.insurer);
  console.log(`\n--- by insurer (${insurers.length} distinct, top 25) ---`); for (const [k, n] of insurers.slice(0, 25)) console.log(`  ${String(n).padStart(4)}  ${k}`);

  const picked = stratifiedSelect(cands, target);
  const pStates = tally(picked, (c) => c.state).length, pYears = tally(picked, (c) => String(c.year)).length, pIns = tally(picked, (c) => c.insurer).length;
  console.log(`\n=== SELECTION: ${picked.length} (target ${target}) spanning ${pIns} insurers / ${pStates} states / ${pYears} years ===`);

  mkdirSync(REAL_DIR, { recursive: true });
  writeFileSync(SELECTION_PATH, JSON.stringify(picked, null, 2));
  console.log(`selection written: ${SELECTION_PATH} (gitignored)`);
}

async function download() {
  if (!existsSync(SELECTION_PATH)) { console.error("no selection — run --introspect first"); process.exit(1); }
  const picked = JSON.parse(readFileSync(SELECTION_PATH, "utf-8")) as Cand[];
  mkdirSync(REAL_DIR, { recursive: true });
  let ok = 0, fail = 0, skip = 0;
  for (const c of picked) {
    const dest = join(REAL_DIR, `${c.seed_id}.pdf`);
    if (existsSync(dest)) { skip++; continue; } // idempotent re-pull (only fetch new)
    const { data, error } = await svc.storage.from("documents").download(c.storage_path);
    if (error || !data) { fail++; console.log(`  ✗ ${c.seed_id}: ${error?.message ?? "no data"}`); continue; }
    const buf = Buffer.from(await data.arrayBuffer());
    writeFileSync(dest, buf);
    ok++;
  }
  console.log(`\ndownloaded ${ok} new (skipped ${skip} existing, fail ${fail}) → _real_pdfs/`);
}

async function main() {
  const args = process.argv.slice(2);
  const target = Number(args.find((a) => a.startsWith("--target"))?.split("=")[1] ?? args[args.indexOf("--target") + 1] ?? 60) || 60;
  if (args.includes("--download")) return download();
  if (args.includes("--introspect")) return introspect(target);
  console.error("usage: --introspect [--target N] | --download");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
