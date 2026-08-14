/**
 * scripts/calibration/fixtures/ops/script-env.ts — S313 CI fixture.
 *
 * Pins the two PURE decisions behind scripts/_env.ts: which database a URL
 * resolves to, and whether a write may proceed.
 *
 * WHY THIS EXISTS when the EXPOSED_FLAGS contract deliberately did NOT get a
 * script: that invariant is expressible as a TYPE, so tsc enforces it natively
 * and a checker would have re-implemented the compiler. This one is not. "An
 * UNKNOWN target refuses writes" is RUNTIME behaviour — no type can state it,
 * and a refactor that inverted the default would pass tsc, pass eslint, and
 * silently leave every PROD write unguarded. That is precisely the shape of
 * bug this repo has learned to pin with a fixture.
 *
 * The stakes: `case-events-backfill.ts --write` writes real user history rows.
 * Wrong database = wrong users' case history, and it is not undoable.
 *
 * Run: npx tsx scripts/calibration/fixtures/ops/script-env.ts
 * Exits 1 on any failure with a precise diff.
 */
import { resolveDbTarget, writeAckVerdict, type DbTarget } from "../../../_env";

const PROD = "https://viahlyugpuviaskpdvce.supabase.co";
const DEV = "https://wdpkmgezhvlmaumhwqua.supabase.co";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label} — expected ${String(expected)}, got ${String(actual)}`);
    failures++;
  }
}

console.log("resolveDbTarget:");
check("prod url + both files → PROD", resolveDbTarget(PROD, PROD, DEV), "PROD");
check("dev url + both files → DEV", resolveDbTarget(DEV, PROD, DEV), "DEV");
check("stranger url → UNKNOWN", resolveDbTarget("https://x.supabase.co", PROD, DEV), "UNKNOWN");
check("empty url → UNKNOWN", resolveDbTarget("", PROD, DEV), "UNKNOWN");
// A missing env file must never turn into a confident answer.
check(".env.local.prod absent, on dev → DEV", resolveDbTarget(DEV, null, DEV), "DEV");
check(".env.local.prod absent, on prod → UNKNOWN", resolveDbTarget(PROD, null, DEV), "UNKNOWN");
check(".env.local.dev absent, on prod → PROD", resolveDbTarget(PROD, PROD, null), "PROD");
check("both files absent → UNKNOWN", resolveDbTarget(PROD, null, null), "UNKNOWN");
// Misconfiguration: if both files hold the SAME url, PROD must win.
check("prod===dev in both files → PROD (fail-closed)", resolveDbTarget(PROD, PROD, PROD), "PROD");
// An empty-string env file value must not match an empty url into a false DEV.
check("empty url vs empty devUrl → UNKNOWN", resolveDbTarget("", PROD, ""), "UNKNOWN");

console.log("\nwriteAckVerdict:");
const cases: Array<[DbTarget, boolean, boolean, "allow" | "refuse", string]> = [
  ["DEV", true, false, "allow", "DEV write, no ack → allow"],
  ["DEV", true, true, "allow", "DEV write, ack → allow"],
  ["PROD", true, false, "refuse", "PROD write, no ack → REFUSE"],
  ["PROD", true, true, "allow", "PROD write, ack → allow"],
  ["UNKNOWN", true, false, "refuse", "UNKNOWN write, no ack → REFUSE (fail-closed)"],
  ["UNKNOWN", true, true, "allow", "UNKNOWN write, ack → allow"],
  ["PROD", false, false, "allow", "PROD dry-run → allow (never gate a read)"],
  ["UNKNOWN", false, false, "allow", "UNKNOWN dry-run → allow"],
  ["DEV", false, false, "allow", "DEV dry-run → allow"],
];
for (const [target, intendsWrite, hasAck, expected, label] of cases) {
  check(label, writeAckVerdict(target, intendsWrite, hasAck), expected);
}

// The load-bearing invariant, stated once as itself: nothing outside DEV
// writes without an acknowledgement. If a future refactor breaks only this,
// every individual case above could still be edited to pass — this cannot.
console.log("\ninvariant:");
const targets: DbTarget[] = ["DEV", "PROD", "UNKNOWN"];
const unguarded = targets.filter(
  (t) => t !== "DEV" && writeAckVerdict(t, true, false) === "allow",
);
check(`no non-DEV target writes un-acked (${unguarded.join(",") || "none"})`, unguarded.length, 0);

if (failures > 0) {
  console.error(`\n✗ script-env fixture FAILED — ${failures} check(s).`);
  process.exit(1);
}
console.log(`\n✓ script-env fixture PASSED (${10 + cases.length + 1} checks).`);
