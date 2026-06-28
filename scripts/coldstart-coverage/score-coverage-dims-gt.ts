/**
 * GT scorer for coverage_dims (committed; replaces the S240 scratchpad). Independent of the parser:
 * reads the oracle's raw.json (forward extraction) + Andrew's adjudicated worksheet-truth.json (copay/
 * coins) + the referral adjudication, and reports — NEVER OFF↔ON agreement, always-vs-truth:
 *   1. in-network copay + coinsurance accuracy (OFF + ON arms) vs truth, with per-cell regressions + coverage
 *   2. referral verdicts on the ON arm (Fix A live) — incl. the step-3↔Fix-A interaction check
 *   3. visit-limit verifier effect on the ON arm (Fix B live)
 * Float-gated: exits non-zero if ON copay/coins accuracy drops below the v3-shipped floor.
 *   OUT_DIR=<oracle-out> npx tsx scripts/coldstart-coverage/score-coverage-dims-gt.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { PlanDocService } from "@/lib/plan_doc/types";

const OUT_DIR = process.env.OUT_DIR || "/private/tmp/oracle-out";
const GT =
  process.env.GT ||
  "/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/coldstart-regen-2026-06-22/worksheet-truth.json";
const COPAY_FLOOR = parseFloat(process.env.COPAY_FLOOR || "0.95");
const COINS_FLOOR = parseFloat(process.env.COINS_FLOOR || "0.97");

type Raw = Record<string, { OFF: PlanDocService[][]; ON: PlanDocService[][] }>;
type GtRow = { plan_id: string; service: string; v1_slug: string; truth_copay: number | null; truth_coins: number | null };

const raw: Raw = JSON.parse(readFileSync(join(OUT_DIR, "raw.json"), "utf8"));
const gt: GtRow[] = JSON.parse(readFileSync(GT, "utf8"));
const docKey = (pid: string) => Object.keys(raw).find((k) => k.slice(0, 8) === pid);
const numEq = (a: number | null | undefined, b: number | null) => (a ?? null) === (b ?? null);

// ---- (1) copay/coins accuracy vs truth, per arm ----
function scoreArm(arm: "OFF" | "ON") {
  let copayOK = 0, coinsOK = 0, matched = 0, unmatched = 0;
  const miss: string[] = [];
  for (const g of gt) {
    const k = docKey(g.plan_id);
    const svcs = k ? raw[k]?.[arm]?.[0] ?? [] : [];
    const svc = svcs.find((s) => s.serviceSlug === g.v1_slug);
    if (!svc) { unmatched++; continue; }
    matched++;
    const cOK = numEq(svc.inCopay, g.truth_copay), coOK = numEq(svc.inCoinsurance, g.truth_coins);
    if (cOK) copayOK++; else if (arm === "ON") miss.push(`  copay ${g.plan_id} ${g.v1_slug}: got ${svc.inCopay} want ${g.truth_copay}`);
    if (coOK) coinsOK++; else if (arm === "ON") miss.push(`  coins ${g.plan_id} ${g.v1_slug}: got ${svc.inCoinsurance} want ${g.truth_coins}`);
  }
  return { copay: copayOK / matched, coins: coinsOK / matched, matched, unmatched, miss };
}
const off = scoreArm("OFF"), on = scoreArm("ON");

console.log(`GT rows: ${gt.length} · matched OFF ${off.matched} / ON ${on.matched} (unmatched ON ${on.unmatched})`);
console.log(`\n===== (1) CORE COST-SHARE accuracy vs truth (NOT OFF↔ON agreement) =====`);
console.log(`  copay  OFF ${(off.copay * 100).toFixed(1)}% → ON ${(on.copay * 100).toFixed(1)}%   (floor ${(COPAY_FLOOR * 100).toFixed(0)}%)`);
console.log(`  coins  OFF ${(off.coins * 100).toFixed(1)}% → ON ${(on.coins * 100).toFixed(1)}%   (floor ${(COINS_FLOOR * 100).toFixed(0)}%)`);
if (on.miss.length) console.log("  ON mismatches vs truth:\n" + on.miss.join("\n"));

// ---- (2) referral verdicts on the ON arm (Fix A) + the step-3↔Fix-A interaction ----
console.log(`\n===== (2) REFERRAL (Fix A live, ON arm) =====`);
let rT = 0, rF = 0, rN = 0;
const trues: string[] = [];
for (const k of Object.keys(raw)) {
  for (const s of raw[k].ON?.[0] ?? []) {
    const r = s.referralRequired;
    if (r === true) { rT++; trues.push(`${k.slice(0, 8)}/${s.serviceSlug}`); }
    else if (r === false) rF++;
    else if (r === null) rN++;
  }
}
console.log(`  verdicts: true ${rT} · false ${rF} · null ${rN}`);
console.log(`  true on: ${trues.join(", ") || "(none)"}`);
const interaction = ["advanced_imaging", "diagnostic_test"].map((slug) => {
  const hit = trues.some((t) => t.endsWith("/" + slug));
  return `${slug}→${hit ? "TRUE ✓" : "not-true ✗"}`;
});
console.log(`  STEP-3↔FIX-A interaction (must be TRUE post-cleanup): ${interaction.join(" · ")}`);

// ---- (3) visit-limit verifier effect (Fix B) on the ON arm ----
console.log(`\n===== (3) VISIT LIMIT (Fix B verifier live, ON arm) =====`);
let vKept = 0, vNull = 0;
const samples: string[] = [];
for (const k of Object.keys(raw)) {
  for (const s of raw[k].ON?.[0] ?? []) {
    if (s.visitLimit != null) { vKept++; if (samples.length < 6) samples.push(`${s.serviceSlug}=${s.visitLimit} ("${(s.annualLimit ?? "").slice(0, 40)}")`); }
    else if (s.visitLimit === null) vNull++;
  }
}
console.log(`  kept (grounded) ${vKept} · null (ungrounded/none) ${vNull}`);
console.log(`  samples: ${samples.join(" · ")}`);

const interactionOk = ["advanced_imaging", "diagnostic_test"].every((slug) => trues.some((t) => t.endsWith("/" + slug)));
const pass = on.copay >= COPAY_FLOOR && on.coins >= COINS_FLOOR && interactionOk;
console.log(`\n${pass ? "PASS ✓" : "FAIL ✗"} — copay≥${COPAY_FLOOR} coins≥${COINS_FLOOR} + interaction`);
process.exit(pass ? 0 : 1);
