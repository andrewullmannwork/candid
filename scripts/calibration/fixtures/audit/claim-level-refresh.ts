/**
 * R3 step 5.1 — refreshClaimLevelFindings: the SHARED claim-level findings refresh used by BOTH
 * re-audit paths (maybeReauditClaim GET + the dispute rerun-audit route), so they cannot drift
 * (the drift was the bug: rerun-audit refreshed per-line findings but left claimLevelFindings
 * stale). Locks: fresh passthrough, dismissal RE-ATTACH by (type, amount) across regenerated ids,
 * and no false match.
 * Run: npx tsx scripts/calibration/fixtures/audit/claim-level-refresh.ts
 */
import { refreshClaimLevelFindings } from "../../../../src/lib/audit/reaudit";
import type { ClaimLevelFindingMeta } from "../../../../src/lib/billing/types";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  got=${JSON.stringify(got)}` : ""}`);
}

const fresh = (over: Partial<ClaimLevelFindingMeta> = {}): ClaimLevelFindingMeta => ({
  id: "new-1",
  type: "unallocated_balance",
  severity: "high",
  estimatedOvercharge: 146,
  title: "Unallocated balance: $146.00",
  actionable: true,
  ...over,
});

// R1 — no prior dismissals → passthrough (fresh findings unchanged, not dismissed).
{
  const out = refreshClaimLevelFindings([fresh()], []);
  check("R1 passthrough length 1", out.length === 1, out.length);
  check("R1 not dismissed", !out[0].dismissed, out[0]);
}

// R2 — a prior dismissal at the SAME (type, amount) re-attaches onto the fresh finding even though
//      the fresh finding carries a NEW id (matching is by type+amount, not id).
{
  const prior = [
    {
      type: "unallocated_balance",
      estimatedOvercharge: 146,
      dismissed: true,
      dismissed_at: "2026-01-01T00:00:00Z",
      dismissed_reason: "user",
      dismissed_note: "not an issue",
    },
  ];
  const out = refreshClaimLevelFindings([fresh({ id: "new-regenerated" })], prior);
  check("R2 dismissal re-attached across regenerated id", out[0].dismissed === true, out[0]);
  check("R2 reason carried", out[0].dismissed_reason === "user", out[0]?.dismissed_reason);
}

// R3 — a prior dismissal at a DIFFERENT amount does NOT match (no false carry).
{
  const prior = [
    { type: "unallocated_balance", estimatedOvercharge: 999, dismissed: true, dismissed_at: "x", dismissed_reason: "user", dismissed_note: null },
  ];
  const out = refreshClaimLevelFindings([fresh({ estimatedOvercharge: 146 })], prior);
  check("R3 different amount → not dismissed", !out[0].dismissed, out[0]);
}

// R4 — a non-dismissed prior is ignored.
{
  const prior = [
    { type: "unallocated_balance", estimatedOvercharge: 146, dismissed: false, dismissed_at: "x", dismissed_reason: "", dismissed_note: null },
  ];
  const out = refreshClaimLevelFindings([fresh()], prior);
  check("R4 non-dismissed prior ignored", !out[0].dismissed, out[0]);
}

// R5 — undefined fresh list → empty.
{
  check("R5 undefined → []", refreshClaimLevelFindings(undefined, []).length === 0);
}

console.log(`\nclaim-level-refresh fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
