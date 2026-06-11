/* T5 Tier-1 routing-distribution report (S190). READ-ONLY analysis over eoc-smoke artifacts.
 *
 * Calls the REAL `routeCriterion` (pure; the same function process-eoc executes) on every saved
 * criterion so the reported distribution validates the shipped decision, not a re-derivation
 * ([[feedback_calibration_independence]] — see route-criterion.ts header).
 *
 * Usage: npx tsx scripts/calibration/thesaurus/t5-tier1-report.ts <artifact-dir> [--tripwires]
 *   --tripwires  also evaluate the S190 T5-lite composition tripwires (N=1 smoke; NOT the §5 floors)
 *
 * UNTRACKED calibration infra (commit decision at T6 alongside eoc-smoke.ts).
 */
import fs from "fs";
import path from "path";
import { loadCalibEnv } from "../../lib/calib-env";
loadCalibEnv();
import { createClient } from "@supabase/supabase-js";
import { routeCriterion, type RouteStore } from "@/lib/eoc/route-criterion";
import { loadServiceRenameMap } from "@/lib/plan_doc/thesaurus-routing";
import { loadValidServiceSlugs } from "@/lib/parser/service-catalog-slugs";
import type { MedicalNecessityCriterion } from "@/lib/eoc/types";

const env = process.env;
const PA_COLUMN_CONFIDENCE_FLOOR = 0.7; // routing-config default (flag config overrides in PROD)
const KNOWN_CATALOG_GAPS = new Set(["maternity_care", "fertility_preservation"]); // pre-existing, both phases (RAW-INDEX 2026-06-10)
const NEGATION_PATTERNS = [/not\s+require/i, /no\s+prior\s+authorization/i, /without\s+prior\s+authorization/i, /not\s+need\s+prior\s+auth/i, /does\s+not\s+require/i];

interface Artifact {
  schema: string;
  doc: string;
  carrier: string;
  mode: "off" | "on";
  run: number;
  warnings: string[];
  costGuardTripped: boolean;
  usage: { correctedCostUsd: number };
  wallMs: number;
  sectionB: { criteriaExtracted: number; unknown: number };
  accumulateCheck: { lostTexts: number };
  options: { sectionFilter: string[] | null; vocabSha256?: string };
  criteria: MedicalNecessityCriterion[];
}

function mnCounter(a: Artifact): { planned: number; dispatched: number } | null {
  for (const w of a.warnings) {
    const m = w.trim().match(/eoc_chunks:medical_necessity:planned=(\d+):dispatched=(\d+)/);
    if (m) return { planned: Number(m[1]), dispatched: Number(m[2]) };
  }
  return null;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  const tripwires = process.argv.includes("--tripwires");
  if (!dir) throw new Error("usage: t5-tier1-report.ts <artifact-dir> [--tripwires]");

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });
  const [renameMap, validSlugs] = await Promise.all([loadServiceRenameMap(sb), loadValidServiceSlugs(sb)]);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();
  const arts: Artifact[] = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  const hashes = new Set(arts.map((a) => a.options.vocabSha256 ?? "ABSENT"));
  console.log(`Loaded ${arts.length} artifacts from ${dir}`);
  console.log(`vocabSha256 set: ${[...hashes].map((h) => h.slice(0, 12)).join(", ")} ${hashes.size === 1 ? "(single — pooling valid)" : "(MIXED — do NOT pool)"}\n`);

  // ── Per (carrier, mode): real-router store distribution ──
  const carriers = [...new Set(arts.map((a) => a.carrier))].sort();
  const stores: RouteStore[] = ["coverage_rules", "pa_column", "pa_facts", "admin_metadata", "enqueue_unknown_slug", "drop"];
  for (const mode of ["off", "on"] as const) {
    console.log(`════ mode=${mode} — routeCriterion store distribution (REAL router, conf floor ${PA_COLUMN_CONFIDENCE_FLOOR}) ════`);
    console.log(`${"carrier".padEnd(12)} ${"docs".padEnd(5)} ${"crit".padEnd(5)} ${stores.map((s) => s.padEnd(21)).join("")}`);
    for (const carrier of carriers) {
      const set = arts.filter((a) => a.carrier === carrier && a.mode === mode);
      const counts: Record<string, number> = Object.fromEntries(stores.map((s) => [s, 0]));
      const paReasons: Record<string, number> = {};
      let total = 0;
      for (const a of set)
        for (const c of a.criteria) {
          const d = routeCriterion(c, { flagOn: mode === "on", confidenceFloor: PA_COLUMN_CONFIDENCE_FLOOR, validSlugs, renameMap });
          counts[d.store]++;
          total++;
          if (d.store === "pa_facts" || d.store === "pa_column") paReasons[d.reason] = (paReasons[d.reason] ?? 0) + 1;
        }
      console.log(
        `${carrier.padEnd(12)} ${String(set.length).padEnd(5)} ${String(total).padEnd(5)} ${stores.map((s) => `${counts[s]}${total ? ` (${((100 * counts[s]) / total).toFixed(0)}%)` : ""}`.padEnd(21)).join("")}`,
      );
      if (Object.keys(paReasons).length) console.log(`${"".padEnd(12)} pa reasons: ${JSON.stringify(paReasons)}`);
    }
    console.log("");
  }

  if (!tripwires) return;

  // ── S190 T5-lite tripwires (composition-only; N=1 — explicitly NOT the §5 floors) ──
  console.log("════ T5-LITE TRIPWIRES (pre-declared S190; composition-only, no count-delta judgments) ════");
  let trips = 0;
  const fire = (id: string, fired: boolean, detail: string): void => {
    if (fired) trips++;
    console.log(`  ${fired ? "🔴 TRIP" : "✅ ok  "} ${id}: ${detail}`);
  };

  // T1 — slug invention: bare (non-proposed_) unknown slugs beyond the known catalog-gap set.
  const bareUnknown: Record<string, Set<string>> = {};
  for (const a of arts)
    for (const c of a.criteria) {
      const hint = c.service_slug_hint;
      if (!hint || hint.startsWith("proposed_")) continue;
      const canon = renameMap.get(hint) ?? hint;
      if (!validSlugs.has(canon) && !KNOWN_CATALOG_GAPS.has(canon)) (bareUnknown[a.carrier] ??= new Set()).add(canon);
    }
  const bareList = Object.entries(bareUnknown).map(([k, v]) => `${k}: ${[...v].join("|")}`);
  fire("T1 invention", bareList.length > 0, bareList.length ? bareList.join(" · ") : "0 novel bare unknowns (known gaps excluded)");

  // T3 — PA polarity: requires-polarity entries whose criteria text greps as a negation.
  const polarityFlags: string[] = [];
  for (const a of arts)
    for (const c of a.criteria) {
      if (c.type === "prior_auth" && c.pa_polarity === "requires" && NEGATION_PATTERNS.some((p) => p.test(c.criteria_text ?? "")))
        polarityFlags.push(`${a.doc}.${a.mode}: [${c.service_slug_hint ?? "(none)"}] ${(c.criteria_text ?? "").slice(0, 90)}`);
    }
  fire("T3 PA negation-as-requires", polarityFlags.length > 0, polarityFlags.length ? polarityFlags.join(" ⏎ ") : "0 requires-polarity entries matching negation patterns");

  // T4 — segmentation: MN found + planned>0 + criteria>0 per doc per mode.
  const segFails: string[] = [];
  for (const a of arts) {
    const mn = mnCounter(a);
    if (!mn || mn.planned === 0) segFails.push(`${a.doc}.${a.mode}: MN section not dispatched`);
    else if (a.sectionB.criteriaExtracted === 0) segFails.push(`${a.doc}.${a.mode}: 0 criteria (planned=${mn.planned})`);
  }
  fire("T4 segmentation", segFails.length > 0, segFails.length ? segFails.join(" · ") : "MN found + dispatched + criteria>0 on all (doc,mode)");

  // T5 — integrity: lost=0, guard, planned==dispatched, excerpt verification ≥90%/carrier.
  const integrity: string[] = [];
  for (const a of arts) {
    const mn = mnCounter(a);
    if (a.accumulateCheck.lostTexts !== 0) integrity.push(`${a.doc}.${a.mode}: lost=${a.accumulateCheck.lostTexts}`);
    if (a.costGuardTripped) integrity.push(`${a.doc}.${a.mode}: guard trip`);
    if (mn && mn.planned !== mn.dispatched) integrity.push(`${a.doc}.${a.mode}: planned!=dispatched`);
  }
  for (const carrier of carriers) {
    const cs = arts.filter((a) => a.carrier === carrier).flatMap((a) => a.criteria);
    const ver = cs.filter((c) => c.source_excerpt_verified).length;
    if (cs.length && ver / cs.length < 0.9) integrity.push(`${carrier}: excerpt verification ${ver}/${cs.length} (<90%)`);
  }
  fire("T5 integrity", integrity.length > 0, integrity.length ? integrity.join(" · ") : "0 lost · 0 guard trips · planned==dispatched · verification ≥90% every carrier");

  // T2 is the distribution table above (gross-anomaly eyeball; no mechanical threshold at N=1).
  console.log(`\nTRIPWIRE RESULT: ${trips === 0 ? "ALL CLEAR" : `${trips} TRIPPED`} (T2 = eyeball the tables above)`);
  const cost = arts.reduce((s, a) => s + a.usage.correctedCostUsd, 0);
  console.log(`Sweep totals: ${arts.length} runs · $${cost.toFixed(2)} corrected · wall sum ${(arts.reduce((s, a) => s + a.wallMs, 0) / 60000).toFixed(1)} min`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
