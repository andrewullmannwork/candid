/**
 * Phase 0 GT-build — best-effort SBC → PROD canonical linker (enriches sbc-sample-manifest.json).
 *
 * canonical_plans.hios_id is 100% NULL, so the link routes: SBC hios14 → plan_catalog.hios_id
 * (authoritative CMS plan_name/state/metal/insurer) → canonical_plans matched by
 * (state + metal HARD filter) + plan-name token-Jaccard. PRECISION-BIASED per "identity decisions
 * bias precision": accept only an unambiguous high-overlap winner; else canonicalPlanId stays null
 * (the doc still scores B1-forward, just not B1-stored). Read-only on PROD.
 *
 * Usage: npx tsx scripts/calibration/thesaurus/enrich-canonicals.ts <freeze-dir>
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- one-shot linker; Supabase query anys */
import { config } from "dotenv";
import { resolve, join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });

const STOP = new Set(["plan", "plans", "health", "the", "of", "and", "for", "a", "an", "with", "ppo", "hmo", "epo", "pos", "hdhp", "individual", "inc", "llc", "company", "insurance"]);
const toks = (s: string) => new Set((s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 1 && !STOP.has(w)));
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
const ACCEPT = 0.5; // min Jaccard to accept
const MARGIN = 0.15; // best must beat 2nd by this much (unambiguous)

async function main() {
  const freezeDir = resolve(process.argv[2] ?? ".");
  const manifest = JSON.parse(readFileSync(join(freezeDir, "sbc-sample-manifest.json"), "utf8")) as any[];
  const hios = manifest.map((m) => m.hios14);

  // hios → plan_catalog authoritative identity
  const pc = new Map<string, { plan_name: string; state: string; metal: string; insurer_id: string | null }>();
  for (let i = 0; i < hios.length; i += 100) {
    const { data } = await supabase.from("plan_catalog").select("hios_id,plan_name,state,metal_level,insurer_id").in("hios_id", hios.slice(i, i + 100));
    for (const r of (data ?? []) as any[]) if (r.hios_id) pc.set(r.hios_id, { plan_name: r.plan_name, state: r.state, metal: (r.metal_level || "").toLowerCase(), insurer_id: r.insurer_id });
  }

  // canonical_plans candidate pool keyed by state|metal
  const cps = new Map<string, { id: string; plan_name: string; toks: Set<string> }[]>();
  const needKeys = new Set([...pc.values()].map((p) => `${p.state}|${p.metal}`));
  for (const key of needKeys) {
    const [st, mt] = key.split("|");
    const { data } = await supabase.from("canonical_plans").select("id,plan_name").eq("state", st).eq("metal_level", mt);
    cps.set(key, ((data ?? []) as any[]).map((r) => ({ id: r.id, plan_name: r.plan_name, toks: toks(r.plan_name) })));
  }
  // insurer names
  const insIds = [...new Set([...pc.values()].map((p) => p.insurer_id).filter(Boolean) as string[])];
  const insName = new Map<string, string>();
  if (insIds.length) { const { data } = await supabase.from("insurer_catalog").select("id,name").in("id", insIds); for (const r of (data ?? []) as any[]) insName.set(r.id, r.name); }

  let linked = 0, ambiguous = 0, noPc = 0, noCand = 0;
  const report: string[] = [];
  for (const m of manifest) {
    const p = pc.get(m.hios14);
    if (!p) { noPc++; report.push(`  ${m.hios14}  —  (not in plan_catalog)`); continue; }
    if (p.insurer_id && insName.has(p.insurer_id)) m.insurer = insName.get(p.insurer_id);
    const cands = cps.get(`${p.state}|${p.metal}`) ?? [];
    if (!cands.length) { noCand++; report.push(`  ${m.hios14}  ${p.plan_name.slice(0, 30)}  —  (no ${p.state}/${p.metal} canonical)`); continue; }
    const pt = toks(p.plan_name);
    const scored = cands.map((c) => ({ c, j: jaccard(pt, c.toks) })).sort((a, b) => b.j - a.j);
    const best = scored[0], second = scored[1];
    if (best.j >= ACCEPT && (!second || best.j - second.j >= MARGIN)) {
      m.canonicalPlanId = best.c.id; linked++;
      report.push(`  ${m.hios14}  j=${best.j.toFixed(2)}  "${p.plan_name.slice(0, 28)}" → "${best.c.plan_name.slice(0, 34)}"`);
    } else {
      ambiguous++;
      report.push(`  ${m.hios14}  j=${best.j.toFixed(2)}${second ? `/${second.j.toFixed(2)}` : ""}  AMBIGUOUS → null  "${p.plan_name.slice(0, 30)}"`);
    }
  }

  writeFileSync(join(freezeDir, "sbc-sample-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(report.join("\n"));
  console.log(`\nlinked ${linked}/${manifest.length} (ambiguous/below-bar→null ${ambiguous}; no plan_catalog ${noPc}; no candidate ${noCand})`);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
