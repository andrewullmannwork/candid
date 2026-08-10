/**
 * bill-dedupe — S307, tracker AM. The bill list shows the copy with the user's
 * work on it, not just the newest copy.
 *
 * Pins the display-layer dedupe's two jobs:
 *   1. The S74 fingerprint rules, byte-for-byte (composite primary, doc-id
 *      fallback, id last-resort, cents rounding) — extraction must not drift.
 *   2. The S307 case-aware representative selection: among rows sharing a
 *      fingerprint, a copy carrying work (a non-cancelled dispute letter, or
 *      guided-step progress in its own metadata) wins over recency; ties keep
 *      newest-wins. The Ballard incident (S304): a verification re-upload
 *      displaced the claim carrying the letters, case and rail.
 *
 * Run: npx tsx scripts/calibration/fixtures/claims/bill-dedupe.ts
 */
import {
  dedupBillsByFingerprint,
  hasCaseWork,
  type DedupableBillRow,
} from "../../../../src/lib/claims/bill-dedupe";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

interface Row extends DedupableBillRow {
  created_at: string;
}

/** Newest-first ordering is the caller contract — build rows accordingly. */
function row(
  id: string,
  opts: {
    date?: string | null;
    total?: number | null;
    provider?: string | null;
    docId?: string | null;
    guideSteps?: Record<string, { checkedAt?: string | null; skippedAt?: string | null } | null>;
    createdAt?: string;
  } = {},
): Row {
  return {
    id,
    source_document_id: opts.docId ?? null,
    date_of_service: opts.date === undefined ? "2023-08-21" : opts.date,
    total_billed: opts.total === undefined ? 1404 : opts.total,
    metadata: {
      ...(opts.provider === null ? {} : { provider: { name: opts.provider ?? "Swedish Allergy Bellevue" } }),
      ...(opts.guideSteps ? { guideSteps: opts.guideSteps } : {}),
    },
    created_at: opts.createdAt ?? "2026-08-10T00:00:00Z",
  };
}

const ids = (rows: Row[]) => rows.map((r) => r.id).join(",");
const NONE: ReadonlySet<string> = new Set();

// ── 1. The S74 fingerprint rules, unchanged ─────────────────────────────────
{
  const newer = row("new", { createdAt: "2026-08-10T00:00:00Z" });
  const older = row("old", { createdAt: "2026-08-05T00:00:00Z" });
  check("same (date,total,provider) collapses → newest wins", ids(dedupBillsByFingerprint([newer, older], NONE)) === "new");

  const noisy = row("noisy", { total: 1404.0000001, createdAt: "2026-08-09T00:00:00Z" });
  check("cents rounding: float noise still collapses", ids(dedupBillsByFingerprint([newer, noisy], NONE)) === "new");

  const otherProvider = row("other", { provider: "Providence" });
  check("different provider → no collapse", dedupBillsByFingerprint([newer, otherProvider], NONE).length === 2);

  const docA1 = row("a1", { provider: null, total: 0, docId: "doc-1", createdAt: "2026-08-10T00:00:00Z" });
  const docA2 = row("a2", { provider: null, total: 0, docId: "doc-1", createdAt: "2026-08-09T00:00:00Z" });
  check("uncomposable + same doc-id → doc fallback collapses", ids(dedupBillsByFingerprint([docA1, docA2], NONE)) === "a1");

  const bare1 = row("b1", { provider: null, total: 0, docId: null });
  const bare2 = row("b2", { provider: null, total: 0, docId: null });
  check("uncomposable + no doc-id → id last-resort, no collapse", dedupBillsByFingerprint([bare1, bare2], NONE).length === 2);
}

// ── 2. Case-aware selection (tracker AM) ────────────────────────────────────
{
  const reupload = row("reupload", { createdAt: "2026-08-10T00:00:00Z" });
  const original = row("original", { createdAt: "2026-08-01T00:00:00Z" });

  // The Ballard shape: the displaced ORIGINAL carries the case.
  check(
    "older copy with letters wins over newer without (Ballard)",
    ids(dedupBillsByFingerprint([reupload, original], new Set(["original"]))) === "original",
  );

  // The 8/21 shape: the RE-UPLOAD carries the case — it stays representative.
  check(
    "newer copy with letters stays representative (8/21)",
    ids(dedupBillsByFingerprint([reupload, original], new Set(["reupload"]))) === "reupload",
  );

  check(
    "both copies worked → newest wins (accepted edge)",
    ids(dedupBillsByFingerprint([reupload, original], new Set(["reupload", "original"]))) === "reupload",
  );

  check(
    "neither worked → newest wins (legacy behavior)",
    ids(dedupBillsByFingerprint([reupload, original], NONE)) === "reupload",
  );

  check(
    "no id set passed → exact legacy behavior even when work exists elsewhere",
    ids(dedupBillsByFingerprint([reupload, original])) === "reupload",
  );

  // Guided-step progress counts as work — read from the row's own metadata.
  const worked = row("worked", {
    createdAt: "2026-08-01T00:00:00Z",
    guideSteps: { "packA:prov-itemized": { checkedAt: "2026-08-01T01:00:00Z" } },
  });
  check(
    "guided-step CHECKED progress wins over newer without",
    ids(dedupBillsByFingerprint([reupload, worked], NONE)) === "worked",
  );

  const skipped = row("skipped", {
    createdAt: "2026-08-01T00:00:00Z",
    guideSteps: { "packA:phone-outcome": { skippedAt: "2026-08-01T01:00:00Z" } },
  });
  check(
    "guided-step SKIPPED progress counts as work too",
    ids(dedupBillsByFingerprint([reupload, skipped], NONE)) === "skipped",
  );

  const emptySteps = row("empty", { createdAt: "2026-08-01T00:00:00Z", guideSteps: {} });
  check(
    "empty guideSteps object is NOT work",
    ids(dedupBillsByFingerprint([reupload, emptySteps], NONE)) === "reupload",
  );

  const nullStamps = row("nullstamps", {
    createdAt: "2026-08-01T00:00:00Z",
    guideSteps: { "packA:prov-itemized": { checkedAt: null, skippedAt: null } },
  });
  check(
    "guideSteps entry with null stamps is NOT work",
    ids(dedupBillsByFingerprint([reupload, nullStamps], NONE)) === "reupload",
  );

  check("hasCaseWork: id-set membership", hasCaseWork(row("x"), new Set(["x"])) === true);
  check("hasCaseWork: no metadata, no membership", hasCaseWork(row("y", { provider: null }), NONE) === false);
}

// ── 3. Order preservation + isolation ───────────────────────────────────────
{
  const a = row("a", { createdAt: "2026-08-10T00:00:00Z" });
  const aDupe = row("a-dupe", { createdAt: "2026-08-04T00:00:00Z" });
  const b = row("b", { provider: "Providence", createdAt: "2026-08-08T00:00:00Z" });
  const c = row("c", { provider: "Ballard Clinic", createdAt: "2026-08-06T00:00:00Z" });

  check(
    "winners keep input (created_at DESC) order",
    ids(dedupBillsByFingerprint([a, b, c, aDupe], NONE)) === "a,b,c",
  );

  check(
    "an older winner appears at its own position",
    ids(dedupBillsByFingerprint([a, b, c, aDupe], new Set(["a-dupe"]))) === "b,c,a-dupe",
  );

  check(
    "work on a unique-fingerprint row changes nothing",
    ids(dedupBillsByFingerprint([a, b], new Set(["b"]))) === "a,b",
  );
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`bill-dedupe: ${pass}/${total} passed`);
  for (const f of fails) console.error(f);
  process.exit(1);
}
console.log(`bill-dedupe: ${pass} passed, 0 failed`);
console.log("ALL GREEN ✓");
