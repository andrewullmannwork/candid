/**
 * scripts/canonical-link-pair-guard.mjs — the canonical link is a PAIR (S292, mig 218).
 *
 * The repo has no test runner (CI = eslint + tsc + build + contract scripts), so
 * this runs as a CI step:
 *   `npx tsx scripts/canonical-link-pair-guard.mjs`
 *
 * WHAT IT PROTECTS
 * `insurance_plans.canonical_plan_id` must never be written without
 * `canonical_match_confidence`. `plan-identity.ts` refuses to decide plan
 * identity on a link it cannot score — an unscored link reads as UNKNOWN — so a
 * half-written link silently disables the resolver's two strongest rules for
 * that plan forever, with nothing failing and nothing logged.
 *
 * WHY A GUARD AND NOT JUST A CONVENTION
 * Before mig 218 there were EIGHT sites writing this link and every one of them
 * computed a real confidence and dropped it. Seven matched an obvious grep; the
 * eighth (`set-active-canonical.ts`) spread the id inside a shared `identity`
 * object literal and matched nothing — it was found by reading, not searching,
 * and it happens to be the search-select path that most users take. A ninth can
 * arrive the same way. `canonicalLinkFields()` makes the pair the only shape you
 * can emit; this makes forgetting to use it fail loudly.
 *
 * HOW IT WORKS
 * Every `canonical_plan_id:` object-literal key under src/ must be either
 * produced by the sanctioned builder or listed below with a reason. The
 * allowlist is deliberately explicit rather than pattern-based: most of these
 * keys target OTHER tables (canonical_plan_services, document_extraction_log,
 * canonical_document_stability, benefit_corrections) or are RPC params and type
 * declarations, and a heuristic that tried to infer the table from context is
 * exactly what missed the eighth site.
 *
 * TO ADD A SITE: if it writes insurance_plans, route it through
 * `canonicalLinkFields()` / `linkPlanToCanonical()`. If it does not, add it here
 * with the table it actually targets.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

/** The single sanctioned writer — `canonicalLinkFields` + `linkPlanToCanonical` live here. */
const SANCTIONED_FILE = "src/lib/plan/canonical-match.ts";

/**
 * Known `canonical_plan_id:` keys that do NOT write insurance_plans.
 * Keyed by "<repo-relative path>" → why it's fine.
 */
const ALLOWLIST = new Map([
  // Each entry was checked by resolving the nearest enclosing .from()/insert
  // target, not by assuming from the filename. None of these touch insurance_plans.
  ["src/lib/plan/extraction-dedup.ts", "document_extraction_log insert + canonical_document_stability upsert; this file's TWO insurance_plans writes go through canonicalLinkFields"],
  ["src/lib/cost/cost-alert-engine.ts", "cost_alert_log rows + candidate type declarations"],
  ["src/lib/cost/cost-per-canonical.ts", "parse_cost_events / insurer_catalog aggregates + row types"],
  ["src/lib/cost/parse-cost-events.ts", "parse_cost_events ledger insert"],
  ["src/lib/parser/auto-reparse-triage.ts", "triage telemetry rows"],
  ["src/lib/parser/canonical-haiku-extractions.ts", "canonical extraction rows"],
  ["src/lib/parser/cf40-v4/divergence-review.ts", "canonical_divergence_review rows"],
  ["src/lib/parser/cf40-v4/record-parse-event.ts", "canonical_document_stability + parse-event ledger rows"],
  ["src/lib/parser/cf40-v4/invalidation.ts", "canonical_document_stability + invalidation ledger rows"],
  ["src/lib/parser/correction-challenge.ts", "canonical_correction_challenges rows + row type"],
  ["src/lib/parser/id-block/inventory.ts", "QuarantineDbRow type declaration"],
  ["src/lib/parser/id-block/quarantine.ts", "canonical_promotion_quarantine rows"],
  ["src/lib/parser/id-block/slack.ts", "Slack message template string, not a DB write"],
  ["src/lib/claims/code-intelligence.ts", "canonical_plan_services read filter"],
  ["src/lib/supabase/types.ts", "BenefitCorrectionRow / row type declarations"],
  ["src/app/api/plan/corrections/route.ts", "benefit_corrections insert"],
  ["src/app/api/compare/premium-observation/route.ts", "premium observation row, not a plan link"],
  ["src/app/api/admin/promotion-quarantine/route.ts", "reads a canonical id off a quarantine row"],
  ["src/app/api/admin/cost-per-canonical/route.ts", "aggregate row shape (type + mapping)"],
  ["src/app/api/disputes/[disputeId]/redraft/route.ts", "loadDecorationContext ARGUMENT, not a table write"],
  ["src/app/api/disputes/generate/route.ts", "loadDecorationContext ARGUMENT, not a table write"],
  ["src/app/(admin)/admin/canonical-quality/page.tsx", "client-side row type declarations"],
  ["src/app/(admin)/admin/cost-per-canonical/page.tsx", "client-side row type declarations"],
  // NOT listed, and deliberately so: promotion-event.ts and
  // corroboration-evaluator.ts pass `p_canonical_plan_id` (RPC params). The
  // key regex requires a non-word char before `canonical_plan_id`, so the `p_`
  // prefix already excludes them — listing them would be a stale entry.
]);

/** Files under src/ worth scanning. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

// `canonical_plan_id:` as an object-literal key (not `p_canonical_plan_id`, not
// a string in a .select()/.eq() — those read, they don't write).
const KEY_RE = /(?<![\w.])canonical_plan_id\s*:/;

const offenders = [];
for (const abs of walk(SRC)) {
  const rel = relative(ROOT, abs);
  if (rel === SANCTIONED_FILE) continue;

  const lines = readFileSync(abs, "utf8").split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    if (KEY_RE.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  if (hits.length === 0) continue;
  if (ALLOWLIST.has(rel)) continue;

  offenders.push({ file: rel, hits });
}

// A stale allowlist entry is its own defect: it means the guard is asserting
// something that is no longer true, which is how a ledger rots into decoration.
const stale = [...ALLOWLIST.keys()].filter((rel) => {
  try {
    return !KEY_RE.test(readFileSync(join(ROOT, rel), "utf8"));
  } catch {
    return true; // file moved or deleted
  }
});

if (offenders.length === 0 && stale.length === 0) {
  console.log(
    `✓ canonical-link pair guard PASSED — every canonical_plan_id write outside ${SANCTIONED_FILE} is accounted for (${ALLOWLIST.size} allowlisted non-insurance_plans sites)`,
  );
  process.exit(0);
}

if (offenders.length > 0) {
  console.error("\n✗ canonical-link pair guard FAILED — unaccounted `canonical_plan_id:` write(s):\n");
  for (const o of offenders) {
    console.error(`  ${o.file}`);
    for (const h of o.hits) console.error(`    ${h.line}: ${h.text}`);
  }
  console.error(
    "\n  If this writes insurance_plans: use canonicalLinkFields(id, confidence) or\n" +
      "  linkPlanToCanonical(...) from @/lib/plan/canonical-match — the link and its\n" +
      "  confidence are ONE unit (mig 218). A bare id stores an unscored link, which\n" +
      "  plan-identity.ts treats as UNKNOWN and can never decide plan identity on.\n" +
      "  If it writes some OTHER table: add it to ALLOWLIST in this file with the\n" +
      "  table it targets.\n",
  );
}

if (stale.length > 0) {
  console.error("✗ canonical-link pair guard FAILED — stale ALLOWLIST entries (no longer contain the key, or file is gone):\n");
  for (const rel of stale) console.error(`  ${rel}`);
  console.error("\n  Remove them so the ledger keeps meaning something.\n");
}

process.exit(1);
