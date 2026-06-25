#!/usr/bin/env npx tsx
/**
 * Cold-start RESOLVER RE-MAP — DRY-RUN (NON-MUTATING preview).
 *
 * Re-resolves the admin cold-start's retained source text (plan_covered_services.sbc_excerpt) through
 * the CURRENT resolver and previews what each canonical service IDENTITY (slug) would become — WITHOUT
 * writing anything to PROD (skipWriteback; no learned-cache mutation; reads only). Produces:
 *   - dryrun-diff.json     per-row {canonicalPlanId, insurer, oldSlug, newSlug, pos, component, excerpt, conf, source, changed, collision}
 *   - dryrun-summary.md    counts + net-change ledger + collisions + ORACLE before/after B1-stored + the regression list
 *
 * Scope: SBC-sourced cold-start only. SCOPE=gt (default) restricts to canonical plans present in the GT
 * (every change is oracle-graded) — the v1 proof. SCOPE=full = all admin SBC/plan_document canonicals (v2).
 *
 * Run (Sonnet, background — costs Haiku for novel excerpts; cache/trigram serve standard SBC labels):
 *   SCOPE=gt npx tsx scripts/calibration/thesaurus/coldstart-remap-dryrun.ts <gt.json> <out-dir>
 */
import { join } from "path";
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { resolveServices, loadCatalogRich, loadResolverConfig, type ResolveLineInput } from "@/lib/claims/service-resolver";
import { loadCalibEnv } from "../../lib/calib-env";
import { loadGt } from "./gt-loader";

const env = loadCalibEnv(["CALIB_USER_ID"]);
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ADMIN = env.CALIB_USER_ID; // cold-start admin == calib user (2ce55772…)
const SCOPE = (process.env.SCOPE ?? "gt").toLowerCase(); // 'gt' (v1, oracle-graded) | 'full' (v2)
const CHUNK = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T = any>(table: string, columns: string, mod?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).range(from, from + 999);
    if (mod) q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

async function main() {
  const [gtPath, outDir] = process.argv.slice(2);
  if (!gtPath || !outDir) throw new Error("usage: coldstart-remap-dryrun.ts <gt.json> <out-dir>");

  const catalog = await loadCatalogRich(supabase);
  if (catalog.some((c) => c.slug === "hospital_outpatient")) throw new Error("stale catalog (mig 152 not reflected) — abort");
  const cfg = await loadResolverConfig(supabase);

  // identity graph: service_catalog id->slug + rename-map (merged_into_id chains) for canonicalization.
  const cat = await fetchAll<{ id: string; slug: string; merged_into_id: string | null }>("service_catalog", "id, slug, merged_into_id");
  const slugById = new Map(cat.map((c) => [c.id, c.slug]));
  const byId = new Map(cat.map((c) => [c.id, c]));
  const renameMap: Record<string, string> = {};
  for (const c of cat) {
    if (!c.merged_into_id) continue;
    let cur = byId.get(c.merged_into_id); const seen = new Set([c.id]);
    while (cur?.merged_into_id && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.merged_into_id); }
    if (cur) renameMap[c.slug] = cur.slug;
  }
  const canon = (s: string | null): string | null => (s == null ? null : (renameMap[s] ?? s));

  // GT: scope set + per-canonical oracle correct-slug sets (SBC scored only, rename-aware).
  const { gt } = loadGt(gtPath, new Set(catalog.map((c) => c.slug)));
  const gtCanonIds = new Set(gt.map((g) => g.canonicalPlanId).filter(Boolean) as string[]);
  const oracleByCanon = new Map<string, Set<string>>();
  for (const g of gt) {
    if (g.docType !== "sbc" || g.notFound || g.correctSlug === null || !g.canonicalPlanId) continue;
    const set = oracleByCanon.get(g.canonicalPlanId) ?? new Set<string>();
    for (const s of [g.correctSlug, ...((g.acceptableSlugs ?? []))]) { const c = canon(s); if (c) set.add(c); }
    oracleByCanon.set(g.canonicalPlanId, set);
  }

  // admin insurance_plans -> canonical (SBC/plan_document sources), scoped.
  const docs = await fetchAll<{ id: string; doc_type: string }>("documents", "id, doc_type", (q) => q.eq("user_id", ADMIN).in("doc_type", ["sbc", "plan_document"]));
  const sbcDocIds = new Set(docs.map((d) => d.id));
  const ips = await fetchAll<{ id: string; canonical_plan_id: string | null; source_document_id: string | null }>(
    "insurance_plans", "id, canonical_plan_id, source_document_id", (q) => q.eq("user_id", ADMIN).not("canonical_plan_id", "is", null));
  const planToCanon = new Map<string, string>();
  for (const p of ips) {
    if (!p.canonical_plan_id) continue;
    if (p.source_document_id && !sbcDocIds.has(p.source_document_id)) continue; // SBC/plan_document only
    if (SCOPE === "gt" && !gtCanonIds.has(p.canonical_plan_id)) continue;
    planToCanon.set(p.id, p.canonical_plan_id);
  }
  const planIds = [...planToCanon.keys()];
  console.log(`scope=${SCOPE} · admin SBC plans in scope=${planIds.length} · distinct canonicals=${new Set(planToCanon.values()).size}`);

  // retained source rows.
  const pcs: { insurance_plan_id: string; service_id: string | null; sbc_excerpt: string | null; place_of_service: string | null; component: string | null }[] = [];
  for (let i = 0; i < planIds.length; i += 100) {
    const chunk = planIds.slice(i, i + 100);
    pcs.push(...await fetchAll("plan_covered_services", "insurance_plan_id, service_id, sbc_excerpt, place_of_service, component", (q) => q.in("insurance_plan_id", chunk)));
  }
  // current stored canonical slug sets (the BEFORE), for grading + collisions.
  const canonIds = [...new Set(planToCanon.values())];
  const storedRows: { canonical_plan_id: string; service_slug: string | null; place_of_service: string | null; component: string | null }[] = [];
  for (let i = 0; i < canonIds.length; i += 100) {
    storedRows.push(...await fetchAll("canonical_plan_services", "canonical_plan_id, service_slug, place_of_service, component", (q) => q.in("canonical_plan_id", canonIds.slice(i, i + 100))));
  }
  const storedSlugsByCanon = new Map<string, Set<string>>();
  const storedKeys = new Set<string>(); // canonical|slug|pos|component (for collision)
  for (const r of storedRows) {
    if (!r.service_slug) continue;
    (storedSlugsByCanon.get(r.canonical_plan_id) ?? storedSlugsByCanon.set(r.canonical_plan_id, new Set()).get(r.canonical_plan_id)!).add(r.service_slug);
    storedKeys.add(`${r.canonical_plan_id}|${r.service_slug}|${r.place_of_service}|${r.component}`);
  }

  // re-resolve every excerpt (skipWriteback) — chunked.
  const resolvable = pcs.filter((r) => r.sbc_excerpt && r.service_id);
  const lines: ResolveLineInput[] = resolvable.map((r, i) => ({ lineNumber: i, description: r.sbc_excerpt as string }));
  const resMap = new Map<number, { slug: string | null; confidence: number; source: string; needsReview: boolean }>();
  for (let i = 0; i < lines.length; i += CHUNK) {
    const m = await resolveServices(lines.slice(i, i + CHUNK), { supabase, userId: ADMIN, config: cfg, catalog, skipWriteback: true, strict: true });
    for (const [k, v] of m) resMap.set(k, { slug: v.slug ?? null, confidence: v.confidence ?? 0, source: v.source ?? "none", needsReview: v.needsReview ?? true });
    console.log(`  resolved ${Math.min(i + CHUNK, lines.length)}/${lines.length}`);
  }

  // per-row diff + ledger + collisions + simulate AFTER sets.
  const diff: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ledger: Record<string, number> = {};
  const afterSlugsByCanon = new Map<string, Set<string>>();
  let changed = 0, collisions = 0;
  const noExcerpt = pcs.length - resolvable.length;
  resolvable.forEach((r, i) => {
    const cpid = planToCanon.get(r.insurance_plan_id)!;
    const oldSlug = r.service_id ? slugById.get(r.service_id) ?? null : null;
    const res = resMap.get(i);
    const newSlug = res?.slug ?? null;
    const after = afterSlugsByCanon.get(cpid) ?? afterSlugsByCanon.set(cpid, new Set()).get(cpid)!;
    if (newSlug) after.add(canon(newSlug) as string);
    const isChanged = newSlug != null && canon(oldSlug) !== canon(newSlug);
    let collision = false;
    if (isChanged) {
      changed++;
      ledger[`${oldSlug ?? "∅"} -> ${newSlug}`] = (ledger[`${oldSlug ?? "∅"} -> ${newSlug}`] ?? 0) + 1;
      collision = storedKeys.has(`${cpid}|${newSlug}|${r.place_of_service}|${r.component}`);
      if (collision) collisions++;
    }
    diff.push({ canonicalPlanId: cpid, oldSlug, newSlug, pos: r.place_of_service, component: r.component, changed: isChanged, collision, confidence: res?.confidence ?? 0, source: res?.source ?? "none", needsReview: res?.needsReview ?? true, excerpt: (r.sbc_excerpt ?? "").slice(0, 160) });
  });

  // ORACLE grading (GT-linked canonicals): before = current stored set; after = re-resolved set. rename-aware.
  let beforeHit = 0, afterHit = 0, denom = 0; const regressions: any[] = [], improvements: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [cpid, oracleSet] of oracleByCanon) {
    if (!storedSlugsByCanon.has(cpid) && !afterSlugsByCanon.has(cpid)) continue;
    const before = new Set([...(storedSlugsByCanon.get(cpid) ?? [])].map((s) => canon(s)));
    const after = afterSlugsByCanon.get(cpid) ?? new Set<string>();
    for (const want of oracleSet) {
      denom++;
      const inB = before.has(want), inA = after.has(want);
      if (inB) beforeHit++; if (inA) afterHit++;
      if (inB && !inA) regressions.push({ canonicalPlanId: cpid, droppedCorrectSlug: want });
      if (!inB && inA) improvements.push({ canonicalPlanId: cpid, gainedCorrectSlug: want });
    }
  }

  writeFileSync(join(outDir, "dryrun-diff.json"), JSON.stringify(diff, null, 2));
  const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : "—";
  const topLedger = Object.entries(ledger).sort((a, b) => b[1] - a[1]);
  const md = [
    `# Cold-start re-map DRY-RUN — scope=${SCOPE} (NON-MUTATING)`, ``,
    `rows in scope: ${pcs.length} (resolvable ${resolvable.length}; no-excerpt ${noExcerpt}) · canonical plans ${canonIds.length}`,
    `**proposed identity changes: ${changed}** (${pct(changed, resolvable.length)} of resolvable) · **4-col collisions (need merge): ${collisions}**`, ``,
    `## Oracle-graded B1-stored (GT-linked SBC canonicals)`,
    `| | recall |`, `|---|---|`,
    `| BEFORE (current stored) | ${pct(beforeHit, denom)} (${beforeHit}/${denom}) |`,
    `| AFTER (re-resolved) | ${pct(afterHit, denom)} (${afterHit}/${denom}) |`,
    `| **delta** | **${(100 * (afterHit - beforeHit) / (denom || 1)).toFixed(1)}pp** |`,
    `| ⚠ REGRESSIONS (correct slug dropped — must be ~0) | ${regressions.length} |`,
    `| improvements (correct slug gained) | ${improvements.length} |`, ``,
    `## Net-change ledger (top 40 old->new)`, ...topLedger.slice(0, 40).map(([k, v]) => `- ${v}× \`${k}\``), ``,
    regressions.length ? `## ⚠ Regression detail\n${regressions.slice(0, 40).map((r) => `- ${r.canonicalPlanId.slice(0, 8)} drops \`${r.droppedCorrectSlug}\``).join("\n")}` : `## ✅ Zero regressions`,
  ].join("\n");
  writeFileSync(join(outDir, "dryrun-summary.md"), md);
  console.log(`\n${md}`);
  console.log(`\nwrote dryrun-diff.json + dryrun-summary.md to ${outDir}`);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
