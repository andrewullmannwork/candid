/**
 * letter-tracks — S304. Which parties a claim has evidence against.
 *
 * An insurer appeal and a provider billing dispute are PARALLEL, not rungs of
 * one ladder. This locks the two sources they derive from, and — more
 * importantly — locks the cases where the derivation must stay SILENT so the
 * caller falls back to today's behaviour.
 *
 * Run: npx tsx scripts/calibration/fixtures/dispute-grounds/letter-tracks.ts
 */
import { deriveLetterTracks } from "../../../../src/lib/disputes/letter-type";
import { deriveFindingToParties, deriveFindingToLetter } from "../../../../src/lib/disputes/dispute-ground-catalog";
import { letterRecipientKind } from "../../../../src/lib/disputes/letter-type";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}
const parties = (t: ReturnType<typeof deriveLetterTracks>) => t.map((x) => x.party).join("+");

// ── The 8/21 bill: two wrongs, two parties, two letters ────────────────────
{
  const t = deriveLetterTracks({ findingTypes: ["unallocated_balance"], insurerUnderpaid: true });
  check("8/21 · both tracks derive", parties(t) === "insurer+provider", t);
  check(
    "8/21 · the provider track rests on the obligated finding",
    t.find((x) => x.party === "provider")?.basis === "obligated_finding",
  );
  check(
    "8/21 · the insurer track rests on the cost-share engine, NOT a finding",
    t.find((x) => x.party === "insurer")?.basis === "insurer_underpaid",
  );
}

// ── Silence is the important behaviour ─────────────────────────────────────
// The commonest finding has NO obligated party (a benchmark overcharge is
// measured against a public reference; nobody owes a duty under it). If this
// ever returns a track, every ordinary overcharge claim starts routing letters
// off a party the catalog never asserted.
{
  check("overcharge alone → NO track (falls back)", deriveLetterTracks({ findingTypes: ["overcharge"], insurerUnderpaid: false }).length === 0);
  check("duplicate alone → NO track", deriveLetterTracks({ findingTypes: ["duplicate"], insurerUnderpaid: false }).length === 0);
  check("unbundling alone → NO track", deriveLetterTracks({ findingTypes: ["unbundling"], insurerUnderpaid: false }).length === 0);
  check("nothing at all → NO track", deriveLetterTracks({ findingTypes: [], insurerUnderpaid: false }).length === 0);
}

// ── Flag-off parity: the insurer signal is gated on recovery_cost_share_v2 ──
// With the flag OFF the engine yields no InsurerDiscrepancy, so `insurerUnderpaid`
// is false and a claim with only unobligated findings derives nothing — which is
// exactly what keeps flag-off behaviour byte-identical to today.
{
  const off = deriveLetterTracks({ findingTypes: ["overcharge"], insurerUnderpaid: false });
  check("flag-off · unobligated findings derive nothing → caller's fallback stands", off.length === 0, off);
  const onlyInsurer = deriveLetterTracks({ findingTypes: ["overcharge"], insurerUnderpaid: true });
  check("flag-on · the engine alone can raise the insurer track", parties(onlyInsurer) === "insurer", onlyInsurer);
}

// ── The curated field, not the template field ──────────────────────────────
// `autoLetterType` routes these three to a PROVIDER letter. They are the
// insurer's to fix, and the catalog says so in obligationElements.
{
  for (const f of ["insurance_underpayment", "missing_adjustment", "zero_cost_share_overcharge"]) {
    const t = deriveLetterTracks({ findingTypes: [f], insurerUnderpaid: false });
    check(`${f} → insurer track (autoLetterType would say provider)`, parties(t) === "insurer", t);
    check(
      `${f} · and the template field really does disagree — the reason this uses party`,
      letterRecipientKind(deriveFindingToLetter()[f as never]) === "provider",
    );
  }
}

// ── A ground may obligate BOTH parties ─────────────────────────────────────
{
  const t = deriveLetterTracks({ findingTypes: ["balance_billing"], insurerUnderpaid: false });
  check("balance_billing alone → both parties, from ONE finding", parties(t) === "insurer+provider", t);
}

// ── Basis precedence + de-duplication ──────────────────────────────────────
{
  const t = deriveLetterTracks({ findingTypes: ["insurance_underpayment"], insurerUnderpaid: true });
  check("one insurer track, not two, when both sources agree", t.filter((x) => x.party === "insurer").length === 1, t);
  check(
    "the obligated finding outranks the engine as the recorded basis",
    t.find((x) => x.party === "insurer")?.basis === "obligated_finding",
  );
  const multi = deriveLetterTracks({ findingTypes: ["unallocated_balance", "chargemaster"], insurerUnderpaid: false });
  check("two provider findings → ONE provider track", multi.length === 1 && multi[0].party === "provider", multi);
}

// ── Order is stable and deliberate ─────────────────────────────────────────
{
  const a = deriveLetterTracks({ findingTypes: ["unallocated_balance"], insurerUnderpaid: true });
  const b = deriveLetterTracks({ findingTypes: ["balance_billing"], insurerUnderpaid: true });
  check("insurer reads first — its deadline is the one that expires", a[0].party === "insurer" && b[0].party === "insurer");
}

// ── The projection omits, never defaults ───────────────────────────────────
// `[]` in the catalog is a deliberate "no obligated party". If a future ground
// is added without obligation elements, it must stay absent rather than
// inheriting a neighbour's party.
{
  const p = deriveFindingToParties();
  check("unobligated grounds are ABSENT from the projection, not empty-arrayed", p["overcharge" as never] === undefined);
  check("obligated grounds are present", (p["unallocated_balance" as never] as unknown as string[])?.[0] === "provider");
}

// ── S305 · the template each track's first letter renders ──────────────────
//
// Not a per-party constant. `balance_billing` obligates the provider AND has
// its own provider-directed template, so `provider → overcharge` would silently
// downgrade the letter today's single-letter fallback already picks. Derived by
// running the SHIPPED dominant-type heuristic over the party's own findings —
// one template heuristic in the codebase, not two — and falling to the party
// default whenever it lands on a template addressed to somebody else.
{
  const typeFor = (t: ReturnType<typeof deriveLetterTracks>, party: string) =>
    t.find((x) => x.party === party)?.letterType;

  const unalloc = deriveLetterTracks({ findingTypes: ["unallocated_balance"], insurerUnderpaid: true });
  check(
    "letterType · unallocated_balance → the provider's first-contact rung",
    typeFor(unalloc, "provider") === "overcharge",
    typeFor(unalloc, "provider"),
  );
  check(
    "letterType · the insurer track's first rung is the appeal",
    typeFor(unalloc, "insurer") === "insurance_appeal",
    typeFor(unalloc, "insurer"),
  );

  // The regression this exists to prevent.
  const bb = deriveLetterTracks({ findingTypes: ["balance_billing"], insurerUnderpaid: false });
  check(
    "letterType · balance_billing keeps its own template on the provider track",
    typeFor(bb, "provider") === "balance_billing",
    typeFor(bb, "provider"),
  );
  check(
    "letterType · and does NOT leak that provider template onto the insurer track",
    typeFor(bb, "insurer") === "insurance_appeal",
    typeFor(bb, "insurer"),
  );

  // The three findings `autoLetterType` misroutes: insurer-obligated, but every
  // one of their templates is provider-directed, so all three must fall to the
  // party default rather than address the wrong recipient.
  for (const f of ["insurance_underpayment", "missing_adjustment", "zero_cost_share_overcharge"]) {
    const t = deriveLetterTracks({ findingTypes: [f], insurerUnderpaid: false });
    check(
      `letterType · ${f} → insurance_appeal (its own template points at the provider)`,
      typeFor(t, "insurer") === "insurance_appeal",
      typeFor(t, "insurer"),
    );
  }

  // A track derived from plan math alone still names a letter.
  const engineOnly = deriveLetterTracks({ findingTypes: [], insurerUnderpaid: true });
  check(
    "letterType · the engine-only insurer track still resolves a template",
    typeFor(engineOnly, "insurer") === "insurance_appeal",
    typeFor(engineOnly, "insurer"),
  );

  // Every derived track resolves to a letter addressed to its OWN party. This
  // is the invariant; the cases above are the instances.
  for (const findingTypes of [
    ["unallocated_balance"],
    ["balance_billing"],
    ["insurance_underpayment"],
    ["zero_cost_share_overcharge"],
    ["unallocated_balance", "balance_billing"],
    ["overcharge", "unallocated_balance"],
  ]) {
    for (const t of deriveLetterTracks({ findingTypes, insurerUnderpaid: true })) {
      check(
        `letterType · [${findingTypes.join("+")}] ${t.party} letter is addressed to the ${t.party}`,
        letterRecipientKind(t.letterType) === t.party,
        { letterType: t.letterType, recipient: letterRecipientKind(t.letterType) },
      );
    }
  }
}

console.log(`\nletter-tracks fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
