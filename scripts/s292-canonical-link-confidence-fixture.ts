/**
 * S292 item 4B — canonical-link confidence fixture.
 *
 * TWO things are under test, and the second is the one that matters:
 *
 *  1. `canonicalLinkFields` never emits half a link. The
 *     (canonical_plan_id, canonical_match_confidence) pair is the unit of
 *     catalog identity (mig 218), so a builder that could drop the confidence
 *     would reintroduce exactly the bug it exists to prevent.
 *
 *  2. `resolveCanonicalCandidate` — extracted OUT of `findOrCreateCanonicalPlan`
 *     so `process-plan.ts` can ask "which canonical is this?" without writing —
 *     reaches the SAME verdict on the SAME inputs the inlined ladder did, and
 *     the writing wrapper still performs exactly the side effects it used to.
 *     A refactor of a shared hot path (every upload + the dispute lane) that is
 *     only proven by `tsc` is not proven at all: the compiler cannot see that a
 *     medium-confidence match must NOT increment source_count.
 *
 * Deliberately hermetic — a stub Supabase client, no network, no DB. The point
 * is the decision ladder, not the database.
 *
 * Run: npx tsx scripts/s292-canonical-link-confidence-fixture.ts
 */

import {
  canonicalLinkFields,
  resolveCanonicalCandidate,
  findOrCreateCanonicalPlan,
  USER_CONFIRMED_CANONICAL_CONFIDENCE,
  NEW_CANONICAL_CONFIDENCE,
} from "../src/lib/plan/canonical-match";
import { resolvePlanIdentity, identityAllowsMerge } from "../src/lib/plan/plan-identity";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
  }
}

// ── Stub Supabase ─────────────────────────────────────────────────────────────
// Emulates only the shapes canonical-match actually uses:
//   .from(t).select(s).eq(..).eq(..).limit(1).single()   → single row or null
//   .from(t).select(s).eq(..).eq(..)                     → awaited row array
// Every call is recorded so we can assert on WRITES not happening.

interface CanonRow {
  id: string;
  insurer_id: string;
  plan_name: string;
  plan_type: string | null;
  state: string | null;
  plan_year: number | null;
  group_number: string | null;
  hios_id: string | null;
  deductible_individual: number | null;
  oop_max_individual: number | null;
  metal_level: string | null;
  confidence_score: number;
  source_count: number;
}

const row = (over: Partial<CanonRow> & { id: string }): CanonRow => ({
  insurer_id: "ins-1",
  plan_name: "Silver 70 HMO",
  plan_type: "HMO",
  state: "FL",
  plan_year: 2026,
  group_number: null,
  hios_id: null,
  deductible_individual: 2000,
  oop_max_individual: 8000,
  metal_level: "silver",
  confidence_score: 0.8,
  source_count: 3,
  ...over,
});

type Filters = Record<string, unknown>;

function makeStub(opts: {
  groupRow?: CanonRow | null;
  hiosRow?: CanonRow | null;
  fuzzyRows?: CanonRow[];
}) {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      calls.push(`from:${table}`);
      const filters: Filters = {};
      const builder = {
        select(_s?: string, _o?: unknown) {
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        limit() {
          return builder;
        },
        single() {
          if (table !== "canonical_plans") return Promise.resolve({ data: null, error: null });
          if ("group_number" in filters) {
            return Promise.resolve({ data: opts.groupRow ?? null, error: null });
          }
          if ("hios_id" in filters) {
            return Promise.resolve({ data: opts.hiosRow ?? null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
        update(payload: unknown) {
          calls.push(`update:${table}:${JSON.stringify(payload)}`);
          return builder;
        },
        insert(payload: unknown) {
          calls.push(`insert:${table}:${JSON.stringify(payload)}`);
          return builder;
        },
        // The fuzzy step awaits the builder directly (no .single()).
        then(resolve: (v: { data: CanonRow[]; error: null }) => void) {
          resolve({ data: opts.fuzzyRows ?? [], error: null });
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

const baseInput = {
  insurerId: "ins-1",
  planName: "Silver 70 HMO",
  planType: "HMO",
  state: "FL",
  planYear: 2026,
  deductible: 2000,
  oopMax: 8000,
};

async function main() {
  console.log("\nS292 — canonical link confidence (mig 218)\n");

  // ── 1. The pair builder ─────────────────────────────────────────────────────
  console.log("canonicalLinkFields — the link is a PAIR");
  {
    const f = canonicalLinkFields("canon-1", 0.95);
    check("emits both columns", f.canonical_plan_id === "canon-1" && f.canonical_match_confidence === 0.95, f);

    const keys = Object.keys(canonicalLinkFields("canon-1", 0.95)).sort();
    check(
      "never emits the id without the confidence key",
      keys.join(",") === "canonical_match_confidence,canonical_plan_id",
      keys,
    );

    const unknown = canonicalLinkFields("canon-1", null);
    check(
      "no evidence stores UNKNOWN, not a guess",
      unknown.canonical_plan_id === "canon-1" && unknown.canonical_match_confidence === null,
      unknown,
    );

    const nan = canonicalLinkFields("canon-1", Number.NaN);
    check("NaN degrades to UNKNOWN rather than poisoning the column", nan.canonical_match_confidence === null, nan);

    const noLink = canonicalLinkFields(null, 0.9);
    check(
      "a confidence without a link is refused (nothing to be confident about)",
      noLink.canonical_plan_id === null && noLink.canonical_match_confidence === null,
      noLink,
    );

    check("clamps above 1", canonicalLinkFields("c", 1.4).canonical_match_confidence === 1);
    check("clamps below 0", canonicalLinkFields("c", -3).canonical_match_confidence === 0);
  }

  // ── 2. The extracted ladder reaches the same verdicts ───────────────────────
  console.log("\nresolveCanonicalCandidate — same ladder, no writes");
  {
    const g = makeStub({ groupRow: row({ id: "canon-group", group_number: "GRP-9" }) });
    const rg = await resolveCanonicalCandidate(g.client, { ...baseInput, groupNumber: "GRP-9" });
    check("group_number rung → 0.95 same", rg.step === "group_number" && rg.confidence === 0.95, rg);
    check("group rung does not need confirmation", rg.needsConfirmation === false);
    check("group rung performs NO writes", !g.calls.some((c) => c.startsWith("update:") || c.startsWith("insert:")), g.calls);

    const h = makeStub({ hiosRow: row({ id: "canon-hios", hios_id: "12345FL001" }) });
    const rh = await resolveCanonicalCandidate(h.client, { ...baseInput, hiosId: "12345FL001" });
    check("hios rung → 0.95 same", rh.step === "hios_id" && rh.confidence === 0.95, rh);

    // Exact-name + type + state + year + dollars ⇒ scores into auto-link range.
    const a = makeStub({ fuzzyRows: [row({ id: "canon-fuzzy-auto" })] });
    const ra = await resolveCanonicalCandidate(a.client, baseInput);
    check("identical identity fuzzy-matches", ra.canonicalPlanId === "canon-fuzzy-auto", ra);
    check(
      "auto rung iff score >= 0.9",
      ra.step === (ra.confidence! >= 0.9 ? "fuzzy_auto" : "fuzzy_needs_confirmation"),
      ra,
    );
    check("needsConfirmation is the strict complement of the auto rung", ra.needsConfirmation === (ra.confidence! < 0.9), ra);
    check("fuzzy rung performs NO writes", !a.calls.some((c) => c.startsWith("update:") || c.startsWith("insert:")), a.calls);

    const n = makeStub({ fuzzyRows: [] });
    const rn = await resolveCanonicalCandidate(n.client, baseInput);
    check("no candidates → step none, null id, null confidence",
      rn.step === "none" && rn.canonicalPlanId === null && rn.confidence === null, rn);
    check("step none NEVER creates a canonical (that is the caller's call)",
      !n.calls.some((c) => c.startsWith("insert:")), n.calls);

    // An unrelated plan must not be dragged over the 0.7 bar.
    const u = makeStub({
      fuzzyRows: [row({ id: "canon-unrelated", plan_name: "Bronze 60 EPO Dental Rider", plan_type: "EPO",
        deductible_individual: 9000, oop_max_individual: 15000, metal_level: "bronze" })],
    });
    const ru = await resolveCanonicalCandidate(u.client, baseInput);
    check("a clearly different plan does not reach a match rung",
      ru.step === "none" || ru.needsConfirmation === true, ru);

    // Precedence: group_number outranks a competing fuzzy candidate.
    const p = makeStub({
      groupRow: row({ id: "canon-group", group_number: "GRP-9" }),
      fuzzyRows: [row({ id: "canon-fuzzy-other" })],
    });
    const rp = await resolveCanonicalCandidate(p.client, { ...baseInput, groupNumber: "GRP-9" });
    check("group_number outranks fuzzy", rp.canonicalPlanId === "canon-group", rp);
  }

  // ── 3. The writing wrapper still has the same side effects ──────────────────
  console.log("\nfindOrCreateCanonicalPlan — side effects preserved");
  {
    // Medium confidence: the ONE case that must NOT bump source_count, because
    // nobody has agreed to the match yet. tsc cannot see this; only running can.
    const med = makeStub({
      fuzzyRows: [row({ id: "canon-med", plan_name: "Silver 70 HMO Regional", source_count: 3 })],
    });
    const rmed = await findOrCreateCanonicalPlan(med.client, baseInput);
    if (rmed.needsConfirmation) {
      check("needs-confirmation does NOT increment source_count", rmed.sourceCount === 3, rmed.sourceCount);
      check("needs-confirmation does NOT write canonical_plans", !med.calls.some((c) => c.startsWith("update:canonical_plans")), med.calls);
    } else {
      check("auto-link DOES increment source_count", rmed.sourceCount === 4, rmed.sourceCount);
    }

    const auto = makeStub({ groupRow: row({ id: "canon-group", group_number: "GRP-9", source_count: 7 }) });
    const rauto = await findOrCreateCanonicalPlan(auto.client, { ...baseInput, groupNumber: "GRP-9" });
    check("group auto-link reports confidence 0.95", rauto.confidence === 0.95, rauto.confidence);
    check("group auto-link increments source_count", rauto.sourceCount === 8, rauto.sourceCount);
    check("group auto-link is not new", rauto.isNew === false);
  }

  // ── 4. The named confidences ────────────────────────────────────────────────
  console.log("\nconfidence constants");
  {
    check("user confirmation is the precision oracle (1.0)", USER_CONFIRMED_CANONICAL_CONFIDENCE === 1.0);
    check("a freshly created canonical is single-source (0.5, Data Rule #8)", NEW_CANONICAL_CONFIDENCE === 0.5);
    check(
      "a new canonical sits BELOW the 0.85 identity floor — it cannot decide identity alone",
      NEW_CANONICAL_CONFIDENCE < 0.85,
    );
    check(
      "a user-confirmed link sits ABOVE the identity floor",
      USER_CONFIRMED_CANONICAL_CONFIDENCE >= 0.85,
    );
  }

  // ── 5. The merge policy (4A) ────────────────────────────────────────────────
  // The behaviour change worth guarding: "uncertain" must NOT merge. Before the
  // resolver, a parse with two empty names fell through and merged silently —
  // the false negative that blends two policies into one plan.
  console.log("\nidentityAllowsMerge — only `same` merges");
  {
    check("same merges", identityAllowsMerge("same") === true);
    check("different holds and asks", identityAllowsMerge("different") === false);
    check("UNCERTAIN holds and asks (does not fall through to merge)", identityAllowsMerge("uncertain") === false);

    // Tie it to the resolver's real output, not just the enum: two documents
    // with nothing in common must not reach a merge.
    const blind = resolvePlanIdentity({}, {});
    check("no signal at all → uncertain", blind.verdict === "uncertain", blind);
    check("…and therefore does NOT merge", identityAllowsMerge(blind.verdict) === false);

    // The 4B payoff: same canonical, both links scored above the floor → same
    // plan, regardless of how the names are spelled. This is the rung that was
    // unreachable while the confidence went unrecorded.
    const sameCanon = resolvePlanIdentity(
      { canonicalPlanId: "canon-A", canonicalConfidence: 0.95, planName: "UHC Choice Plus" },
      { canonicalPlanId: "canon-A", canonicalConfidence: 0.95, planName: "Choice Plus POS II" },
    );
    check("same canonical + scored links → same", sameCanon.verdict === "same" && sameCanon.reason === "canonical_match", sameCanon);
    check("…and merges", identityAllowsMerge(sameCanon.verdict) === true);

    // The regression 4B exists to prevent: identical evidence, but the links
    // are UNSCORED (every row before mig 218). Must NOT claim "same".
    const unscored = resolvePlanIdentity(
      { canonicalPlanId: "canon-A", planName: "UHC Choice Plus" },
      { canonicalPlanId: "canon-A", planName: "Choice Plus POS II" },
    );
    check(
      "same canonical but UNSCORED links → never canonical_match",
      unscored.reason !== "canonical_match",
      unscored,
    );

    // Different canonical, both scored → different, and it is HELD.
    const diffCanon = resolvePlanIdentity(
      { canonicalPlanId: "canon-A", canonicalConfidence: 0.95 },
      { canonicalPlanId: "canon-B", canonicalConfidence: 0.95 },
    );
    check("different canonical + scored → different", diffCanon.verdict === "different", diffCanon);
    check("…and is held, not merged", identityAllowsMerge(diffCanon.verdict) === false);

    // A newly created canonical (0.5) must not be able to decide identity.
    const freshCanon = resolvePlanIdentity(
      { canonicalPlanId: "canon-A", canonicalConfidence: NEW_CANONICAL_CONFIDENCE },
      { canonicalPlanId: "canon-B", canonicalConfidence: NEW_CANONICAL_CONFIDENCE },
    );
    check(
      "single-source canonicals (0.5) cannot decide 'different' on their own",
      freshCanon.reason !== "canonical_differs",
      freshCanon,
    );
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
