/**
 * Phase 0 — deterministically build the frozen GT corpus manifest + 20 cohorts (READ-ONLY).
 * Output: gt-doc-manifest.json (re-parse list) + cohorts.json (B3). No Haiku, no writes to PROD.
 * npx tsx scripts/calibration/thesaurus/build-selection.ts <out-dir>
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- one-shot selection builder; Supabase query-builder anys */
import { config } from "dotenv";
import { resolve, join } from "path";
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });

async function fetchAll<T = any>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

const TARGET_INSURERS = ["Medica", "Anthem", "Ambetter", "Oscar", "Blue Shield of Cal", "Florida Blue", "UnitedHealthcare", "Cigna"];
const DOCS_PER_INSURER = 4;

async function main() {
  const outDir = resolve(process.argv[2] ?? ".");
  const ic = await fetchAll<{ id: string; name: string }>("insurer_catalog", "id,name");
  const insName = new Map(ic.map((r) => [String(r.id), r.name]));
  const cp = await fetchAll<any>("canonical_plans", "id,insurer_id,plan_year,metal_level,state");
  const cps = await fetchAll<{ canonical_plan_id: string }>("canonical_plan_services", "canonical_plan_id");
  const svc = new Map<string, number>();
  for (const r of cps) svc.set(r.canonical_plan_id, (svc.get(r.canonical_plan_id) ?? 0) + 1);
  const ip = await fetchAll<any>("insurance_plans", "insurer_name,plan_year,source_document_id,canonical_plan_id");

  const nameOf = (p: any) => insName.get(String(p.insurer_id)) ?? "?";
  const enrich = (id: string) => { const p = cp.find((x) => x.id === id); return p ? { id, insurer: nameOf(p), metal: p.metal_level, year: p.plan_year, state: p.state, svc: svc.get(id) ?? 0 } : null; };
  const sorted = (arr: any[]) => [...arr].sort((a, b) => a.id.localeCompare(b.id)); // deterministic

  // ── gt-doc-manifest: per target insurer, metal-diverse source docs (have storage PDFs) ──
  const docToPlan = new Map<string, any>();
  for (const r of ip) if (r.source_document_id && !docToPlan.has(r.source_document_id)) docToPlan.set(r.source_document_id, r);
  const docIds = [...docToPlan.keys()];
  const docMeta = new Map<string, any>();
  for (let i = 0; i < docIds.length; i += 300) {
    const { data } = await supabase.from("documents").select("id,classified_type,storage_path,file_size").in("id", docIds.slice(i, i + 300));
    for (const d of data ?? []) docMeta.set(d.id, d);
  }
  const manifest: any[] = [];
  for (const t of TARGET_INSURERS) {
    const docs = sorted(
      [...docToPlan.entries()]
        .filter(([, pl]) => (pl.insurer_name ?? "").toLowerCase().includes(t.toLowerCase()) && docMeta.get(pl.source_document_id as string)?.storage_path)
        .map(([docId, pl]) => ({ id: docId, ...enrich(pl.canonical_plan_id), insurerName: pl.insurer_name, storage_path: docMeta.get(docId)?.storage_path, classified_type: docMeta.get(docId)?.classified_type }))
    );
    // metal-diverse pick: one per distinct metal, then fill to DOCS_PER_INSURER
    const byMetal = new Map<string, any>();
    for (const d of docs) if (d.metal && !byMetal.has(d.metal)) byMetal.set(d.metal, d);
    const picked = [...byMetal.values()].slice(0, DOCS_PER_INSURER);
    for (const d of docs) { if (picked.length >= DOCS_PER_INSURER) break; if (!picked.includes(d)) picked.push(d); }
    for (const d of picked) manifest.push({ docId: d.id, insurer: d.insurerName, planYear: d.year, metal: d.metal, state: d.state, canonicalPlanId: d.canonicalPlanId ?? null, storage_path: d.storage_path, classified_type: d.classified_type, source: "prod_storage_reparse" });
  }

  // ── cohorts: 20 fixed 3-plan sets ──
  const full = sorted(cp.map((p) => enrich(p.id)).filter((e) => e && e.svc >= 40));
  const mid = sorted(cp.map((p) => enrich(p.id)).filter((e) => e && e.svc >= 26 && e.svc <= 33)); // gap-prone band
  const byIns = (arr: any[], t: string) => arr.filter((e) => e.insurer.toLowerCase().includes(t.toLowerCase()));
  const cohorts: any[] = [];
  const push = (id: string, ids: any[], rationale: string) => { if (ids.length === 3 && ids.every(Boolean)) cohorts.push({ cohortId: id, canonicalPlanIds: ids.map((e) => e.id), rationale, plans: ids.map((e) => `${e.insurer}/${e.metal}/${e.svc}svc`) }); };

  // 6 cross-insurer full (insurer diversity, low gap)
  const fullIns = TARGET_INSURERS.map((t) => byIns(full, t)).filter((a) => a.length);
  for (let i = 0; i < 6 && fullIns.length >= 3; i++) {
    const trio = [fullIns[i % fullIns.length], fullIns[(i + 1) % fullIns.length], fullIns[(i + 2) % fullIns.length]].map((a, j) => a[(i + j) % a.length]);
    push(`xins-full-${i + 1}`, trio, "cross-insurer full plans (insurer diversity; low-gap control)");
  }
  // 6 gap-prone (1-2 mid/sparse + full)
  for (let i = 0; i < 6 && mid.length; i++) {
    const trio = [mid[i % mid.length], mid[(i + 7) % mid.length], full[(i * 5) % full.length]];
    push(`gap-${i + 1}`, trio, "gap-prone: includes 26-33-svc plans to surface 'Not listed yet'");
  }
  // 4 same-insurer metal spread (within-insurer consistency)
  for (const t of ["Ambetter", "Oscar", "UnitedHealthcare", "Blue Shield of Cal"]) {
    const grp = sorted(byIns(full.concat(mid), t));
    const metals = new Map<string, any>();
    for (const e of grp) if (e.metal && !metals.has(e.metal)) metals.set(e.metal, e);
    const trio = [...metals.values()].slice(0, 3);
    push(`same-${t.split(" ")[0].toLowerCase()}`, trio, `same-insurer (${t}) metal spread — within-insurer consistency probe`);
  }
  // 4 mixed metal/state full
  for (let i = 0; i < 4; i++) push(`mixed-${i + 1}`, [full[(i * 11) % full.length], full[(i * 11 + 37) % full.length], full[(i * 11 + 71) % full.length]], "mixed metal/state full plans");

  writeFileSync(join(outDir, "gt-doc-manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, "cohorts.json"), JSON.stringify({ cohorts }, null, 2));
  console.log(`gt-doc-manifest.json: ${manifest.length} docs across ${new Set(manifest.map((m) => m.insurer)).size} insurers`);
  console.log(`  by insurer:`, [...new Set(manifest.map((m) => m.insurer))].join(", "));
  console.log(`cohorts.json: ${cohorts.length} cohorts`);
  for (const c of cohorts) console.log(`  ${c.cohortId.padEnd(14)} ${c.plans.join("  ")}  — ${c.rationale}`);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
