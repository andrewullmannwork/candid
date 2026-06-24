/**
 * Cost-Share v2 (W4) — letter version-history fixtures.
 * Locks appendLetterVersion: newest-last, cap (drop-oldest), empty-content no-op, null-safe.
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/letter-versions.ts
 */
import {
  appendLetterVersion,
  type LetterVersion,
} from "../../../../src/lib/disputes/evidence-fingerprint";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)}`);
}
const v = (c: string): LetterVersion => ({ content: c, fingerprint: `fp_${c}`, savedAt: `2026-06-24T00:0${c}:00Z` });

// 1 — append to empty (null history) → [entry]
{
  const r = appendLetterVersion(null, v("1"));
  check("1 null history → single entry", r.length === 1 && r[0].content === "1", r);
}

// 2 — append within cap → grows, newest LAST
{
  const r = appendLetterVersion([v("1"), v("2")], v("3"));
  check("2 grows to 3, newest last", r.length === 3 && r[2].content === "3" && r[0].content === "1", r);
}

// 3 — append OVER cap (3) → drop oldest, keep newest 3
{
  const r = appendLetterVersion([v("1"), v("2"), v("3")], v("4"));
  check("3 caps at 3", r.length === 3, r.length);
  check("3 drops oldest (1 gone)", r[0].content === "2" && r[2].content === "4", r.map((x) => x.content));
}

// 4 — empty content → no-op (don't store an absent letter)
{
  const base = [v("1")];
  const r = appendLetterVersion(base, { content: "", fingerprint: null, savedAt: "x" });
  check("4 empty content is a no-op", r.length === 1 && r[0].content === "1", r);
}

// 5 — undefined history is null-safe
{
  const r = appendLetterVersion(undefined, v("9"));
  check("5 undefined history → [entry]", r.length === 1 && r[0].content === "9", r);
}

// 6 — custom cap honored
{
  const r = appendLetterVersion([v("1"), v("2")], v("3"), 2);
  check("6 cap=2 keeps newest 2", r.length === 2 && r[0].content === "2" && r[1].content === "3", r.map((x) => x.content));
}

console.log(`\ncost-share-v2 letter-version fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
