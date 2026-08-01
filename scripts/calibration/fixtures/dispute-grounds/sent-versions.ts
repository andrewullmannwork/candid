/**
 * sent-versions fixture (S299 phase 2a) — the §0.9 rule-4 version stack.
 *
 * Locks: banking on mark-sent (idempotent against double-submits), the §0.9b
 * unsend stamp (latest un-unsent entry only; legacy rows no-op), read
 * defensiveness on malformed metadata, and Case-2 resend (a second genuine
 * send after an unsend banks a NEW entry — two artifacts, one step).
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/sent-versions.ts
 */
import {
  bankSentVersion,
  stampUnsent,
  readSentVersions,
} from "../../../../src/lib/disputes/sent-versions";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

const T1 = "2026-07-30T22:00:00.000Z";
const T2 = "2026-07-31T18:00:00.000Z";
const T3 = "2026-08-01T12:00:00.000Z";

// Bank on a fresh row.
let meta = bankSentVersion(null, "BODY v1", T1);
check("bank · fresh row → one entry", readSentVersions(meta).length === 1);
check("bank · entry shape", readSentVersions(meta)[0].body === "BODY v1" && readSentVersions(meta)[0].sentAt === T1);

// Idempotent re-click: same un-unsent body refreshes in place, no duplicate.
meta = bankSentVersion(meta, "BODY v1", T2);
check("bank · double-submit refreshes, no duplicate", readSentVersions(meta).length === 1, readSentVersions(meta).length);
check("bank · refresh keeps latest sentAt", readSentVersions(meta)[0].sentAt === T2);

// §0.9b unsend: latest entry stamped, retained.
meta = stampUnsent(meta, T3);
const afterUnsend = readSentVersions(meta);
check("unsend · stamped not deleted", afterUnsend.length === 1 && afterUnsend[0].unsentAt === T3);

// Case 2 — a genuine resend after unsend banks a NEW entry.
meta = bankSentVersion(meta, "BODY v2", T3);
const stack = readSentVersions(meta);
check("resend · new entry after unsend", stack.length === 2, stack.length);
check("resend · prior stays labeled", stack[0].unsentAt === T3 && stack[1].unsentAt == null);

// Unsend stamps ONLY the latest un-unsent entry.
meta = stampUnsent(meta, "2026-08-02T00:00:00.000Z");
const stack2 = readSentVersions(meta);
check("unsend · targets latest un-unsent only", stack2[0].unsentAt === T3 && stack2[1].unsentAt === "2026-08-02T00:00:00.000Z");

// Legacy row with nothing outstanding: no-op, no throw.
const legacy = stampUnsent({ some: "field" }, T1);
check("unsend · legacy no-op", readSentVersions(legacy).length === 0 && legacy.some === "field");

// Defensive read on malformed metadata.
check("read · malformed → []", readSentVersions({ sentVersions: "nope" }).length === 0);
check("read · partial entries filtered", readSentVersions({ sentVersions: [{ body: 1 }, { body: "ok", sentAt: T1 }] }).length === 1);

// Other metadata keys survive both writers.
const merged = bankSentVersion({ letterType: "insurance_appeal" }, "B", T1);
check("bank · preserves sibling metadata", merged.letterType === "insurance_appeal");

// Recipient-as-mailed (S299 E2E "Test" clobber): the version banks its
// collector at send time; readers prefer it over mutable current metadata.
const withRecipient = bankSentVersion(null, "B", T1, { name: "Cascade Recovery", address: null });
check(
  "bank · collector banked as mailed",
  readSentVersions(withRecipient)[0].collector?.name === "Cascade Recovery",
);
const noRecipient = bankSentVersion(null, "B", T1);
check(
  "bank · absent collector stays absent (legacy fallback path)",
  readSentVersions(noRecipient)[0].collector === undefined,
);

console.log(`\nsent-versions fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
