/**
 * Ing-D.0f — CF-40 v4 pure-fixture suite runner (Ship Gate G4 CI entrypoint).
 *
 * Runs EVERY per-layer pure decision fixture in one command and aggregates the
 * results into a single exit code. These are deterministic, DB-free, offline — the
 * "unit suite" that locks v4's decision logic across all 5 layers + the orchestrator +
 * the Layer-3(b) minority router. Wire this one script into CI (the standing G4
 * follow-up obligation); the read-only integration dry-run
 * (cf40-v4-integration-dryrun.ts) is the separate online flip-readiness gate.
 *
 *   npx tsx scripts/cf40-v4-all-fixtures.ts
 */

import { spawnSync } from "child_process";

const FIXTURES = [
  "scripts/test-cf40-v4-algorithm.ts", // L1/L2/L3/L5 + orchestrator + badge
  "scripts/cf40-v4-layer1-and-skip-fixture.ts", // L1 contribution gate + smart-skip (D.0b)
  "scripts/cf40-v4-doctype-promotion-fixture.ts", // L3 aggregation + promotion (D.0a)
  "scripts/cf40-v4-slow-drift-and-reset-fixture.ts", // L4 slow-drift + re-baseline reset (D.0c-i)
  "scripts/cf40-v4-rapid-change-and-verification-fixture.ts", // L4 rapid-change + verification (D.0c-ii)
  "scripts/cf40-v4-minority-router-fixture.ts", // L3(b) minority router (D.0d)
];

let failed = 0;
console.log("\n══ CF-40 v4 pure-fixture suite ══\n");
for (const f of FIXTURES) {
  const r = spawnSync("npx", ["tsx", f], { encoding: "utf8" });
  const out = (r.stdout ?? "").trim().split("\n");
  const summary = out[out.length - 1] ?? "(no output)";
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "✅" : "❌"} ${f.replace("scripts/", "")}`);
  console.log(`     ${summary}`);
  if (!ok) {
    if (r.stderr) console.log(r.stderr.trim().slice(0, 800));
    else console.log(out.filter((l) => l.includes("✗")).join("\n"));
  }
}

console.log(
  `\n${failed === 0 ? "✅ ALL CF-40 v4 PURE FIXTURES PASS" : `❌ ${failed} fixture file(s) FAILED`}\n`,
);
process.exit(failed === 0 ? 0 : 1);
