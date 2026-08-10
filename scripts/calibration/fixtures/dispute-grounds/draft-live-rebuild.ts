/**
 * draft-live-rebuild fixture (S306, tracker AF / UX-2) — "a draft letter is a
 * live document; a sent letter is a record" (Andrew).
 *
 * Locks the pure halves of the live-rebuild design:
 *   · the compose extension is PRESENT-ONLY — absent keeps the hash
 *     byte-identical to the legacy fingerprint (flag-off / sent-letter safety)
 *   · a compose-only edit (the provider address, the attested name) drifts the
 *     hash — the exact inputs the evidence hash was blind to
 *   · composeBasisFrom maps blanks/missing to null identically (a blank
 *     address can never spuriously drift a hash)
 *   · decideDriftAction with debounceMinutes 0 regenerates on mismatch even
 *     inside the old 5-minute window (a live draft never waits out a debounce)
 *   · the unsend guarantee: an evidence-only stored hash vs a compose-inclusive
 *     current hash is a MISMATCH, so the first view after unsend rebuilds
 *
 * The shape rule itself (compose only when unsent + flag ON) lives in
 * loadFingerprintInputForClaim, which is DB-coupled — proven by the live E2E,
 * not here. Same division as prior-contact: pure fixtures test the derivation,
 * the driven E2E tests the wiring.
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/draft-live-rebuild.ts
 */
import {
  computeEvidenceFingerprint,
  composeBasisFrom,
  decideDriftAction,
  type FingerprintInput,
  type ComposeBasis,
} from "../../../../src/lib/disputes/evidence-fingerprint";
import {
  letterPatientName,
  letterPatientIdentityFromMeta,
} from "../../../../src/lib/disputes/letter-type";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

const BASE: FingerprintInput = {
  findings: [{ type: "overcharge" as never, slug: "office-visit", amount: 33.85 }],
  lineItems: [{ service_slug: "office-visit", line_number: 1 }],
  totalRecoveryEstimate: 33.85,
};

const COMPOSE: ComposeBasis = {
  attestingName: "Andrew Ullmann",
  patientIdentityChoice: null,
  patientCorrectedName: null,
  providerName: "SWEDISH ALLERGY BELLEVUE",
  providerAddress: "747 Broadway, Seattle, WA 98122",
  insurerAddressOverride: null,
  collector: null,
  accountNumber: "ACCT-123",
  collectorFirstContactDate: null,
  denialNoticeDate: null,
  certifiedMail: null,
  appealExhausted: null,
};

// ── 1. Present-only: absent compose ≡ the legacy hash ───────────────────────
{
  const legacy = computeEvidenceFingerprint(BASE);
  const explicitAbsent = computeEvidenceFingerprint({ ...BASE, composeBasis: null });
  const withCompose = computeEvidenceFingerprint({ ...BASE, composeBasis: COMPOSE });
  check("present-only · null compose is byte-identical to legacy", explicitAbsent === legacy);
  check("present-only · a compose basis changes the hash", withCompose !== legacy);
}

// ── 2. Compose-only edits drift the hash ────────────────────────────────────
{
  const a = computeEvidenceFingerprint({ ...BASE, composeBasis: COMPOSE });
  const addressChanged = computeEvidenceFingerprint({
    ...BASE,
    composeBasis: { ...COMPOSE, providerAddress: "1600 E Jefferson St, Seattle, WA" },
  });
  const nameChanged = computeEvidenceFingerprint({
    ...BASE,
    composeBasis: { ...COMPOSE, attestingName: "Bonnie Jean Haberzetle" },
  });
  const same = computeEvidenceFingerprint({ ...BASE, composeBasis: { ...COMPOSE } });
  check("drift · provider address alone drifts the hash", addressChanged !== a);
  check("drift · attested name alone drifts the hash", nameChanged !== a);
  check("drift · identical compose hashes identically", same === a);
}

// ── 3. composeBasisFrom — blanks and missing are the same null ──────────────
{
  const fromEmpty = composeBasisFrom(null, null);
  check(
    "mapping · fully absent metadata → all-null basis",
    Object.values(fromEmpty).every((v) => v === null),
    fromEmpty,
  );
  const blankVsMissing =
    JSON.stringify(composeBasisFrom({ attestingAsName: "   " }, { provider: { name: "" } })) ===
    JSON.stringify(composeBasisFrom({}, {}));
  check("mapping · blank strings ≡ missing keys", blankVsMissing);
  const mapped = composeBasisFrom(
    {
      attestingAsName: " Andrew Ullmann ",
      insurerAddressOverride: { line1: "PO Box 1", city: "Cheyenne", state: "WY", postalCode: "82001" },
      collector: { name: "ACME Recovery", originalCreditor: "Swedish" },
      accountNumber: "A-9",
    },
    { provider: { name: "SWEDISH", address: "747 Broadway" } },
  );
  check("mapping · trims the attested name", mapped.attestingName === "Andrew Ullmann");
  check("mapping · provider comes from the CLAIM metadata", mapped.providerName === "SWEDISH" && mapped.providerAddress === "747 Broadway");
  check("mapping · address override carried with null line2", mapped.insurerAddressOverride?.line1 === "PO Box 1" && mapped.insurerAddressOverride?.line2 === null);
  check("mapping · collector carried with null address", mapped.collector?.name === "ACME Recovery" && mapped.collector?.address === null);
}

// ── 4. debounce 0 — a live draft never waits ────────────────────────────────
{
  const inWindow = decideDriftAction({
    storedFingerprint: "aaa",
    currentFingerprint: "bbb",
    sentAt: null,
    cooldownUntil: null,
    lastRefreshAt: new Date(Date.now() - 60 * 1000), // refreshed 1 min ago
  });
  check(
    "debounce · default 5-min window still debounces (flag OFF unchanged)",
    inWindow.action === "serve_cached_within_debounce",
    inWindow,
  );
  const live = decideDriftAction({
    storedFingerprint: "aaa",
    currentFingerprint: "bbb",
    sentAt: null,
    cooldownUntil: null,
    lastRefreshAt: new Date(Date.now() - 60 * 1000),
    debounceMinutes: 0,
  });
  check("debounce · 0 → regenerate on mismatch immediately", live.action === "regenerate_draft", live);
  const match = decideDriftAction({
    storedFingerprint: "aaa",
    currentFingerprint: "aaa",
    sentAt: null,
    cooldownUntil: null,
    lastRefreshAt: null,
    debounceMinutes: 0,
  });
  check("debounce · matching hash still serves cached (no hot loop)", match.action === "serve_cached", match);
  const sent = decideDriftAction({
    storedFingerprint: "aaa",
    currentFingerprint: "bbb",
    sentAt: new Date(),
    cooldownUntil: null,
    lastRefreshAt: null,
    debounceMinutes: 0,
  });
  check("debounce · sent letters still banner, never regenerate", sent.action === "show_drift_banner_for_sent", sent);
}

// ── 4b. The letter patient name — ONE derivation (S306 T1) ──────────────────
// Before this there were three mechanisms: the server's account-holder default,
// a client-side substitution whose "dependent" branch no-opped, and a hash
// watching a key the compose never read. This is the one rule both the compose
// and the hash now share.
{
  const BILL = "Bonnie Jean Haberzetle";
  const ACCT = "Andrew Ullmann";
  check("name · 'me' → the account holder", letterPatientName({ choice: "me", correctedName: null }, BILL, ACCT) === ACCT);
  check("name · 'dependent' → the bill's own patient", letterPatientName({ choice: "dependent", correctedName: null }, BILL, ACCT) === BILL);
  check("name · 'wrong' → the typed correction", letterPatientName({ choice: "wrong", correctedName: "Nicole Marie Gurtler" }, BILL, ACCT) === "Nicole Marie Gurtler");
  check("name · unanswered → the default (tracker AS intact)", letterPatientName(null, BILL, ACCT) === ACCT);
  check("name · 'dependent' with a BLANK bill name falls back, never blanks", letterPatientName({ choice: "dependent", correctedName: null }, "  ", ACCT) === ACCT);
  check("name · 'wrong' with a blank correction falls back, never blanks", letterPatientName({ choice: "wrong", correctedName: "  " }, BILL, ACCT) === ACCT);
  check(
    "name · metadata reader maps the persisted keys",
    JSON.stringify(letterPatientIdentityFromMeta({ patientIdentityChoice: "wrong", patientCorrectedName: " Nicole Marie Gurtler " })) ===
      JSON.stringify({ choice: "wrong", correctedName: "Nicole Marie Gurtler" }),
  );
  check("name · junk choice reads as unanswered", letterPatientIdentityFromMeta({ patientIdentityChoice: "bogus" }) === null);

  // And the hash sees what the derivation reads — the T1 failure, pinned.
  const before = computeEvidenceFingerprint({ ...BASE, composeBasis: COMPOSE });
  const afterChoice = computeEvidenceFingerprint({
    ...BASE,
    composeBasis: { ...COMPOSE, patientIdentityChoice: "dependent" },
  });
  const afterCorrection = computeEvidenceFingerprint({
    ...BASE,
    composeBasis: { ...COMPOSE, patientIdentityChoice: "wrong", patientCorrectedName: "Nicole Marie Gurtler" },
  });
  check("name · the identity CHOICE alone drifts the hash", afterChoice !== before);
  check("name · the correction drifts it again", afterCorrection !== afterChoice);
  const dates = computeEvidenceFingerprint({
    ...BASE,
    composeBasis: { ...COMPOSE, collectorFirstContactDate: "2026-08-01" },
  });
  const certified = computeEvidenceFingerprint({
    ...BASE,
    composeBasis: { ...COMPOSE, certifiedMail: true },
  });
  check("name · the §1692g anchor date drifts the hash", dates !== before);
  check("name · the certified choice drifts the hash", certified !== before);
}

// ── 5. The unsend guarantee ─────────────────────────────────────────────────
// Mark-as-sent stamps evidence-only; after unsend the draft compare is
// compose-inclusive. Same underlying inputs → still a mismatch → the first
// post-unsend view rebuilds. (The two shapes can only collide if the compose
// JSON contributed nothing, which present-only check 1 already excludes.)
{
  const stampedAtSend = computeEvidenceFingerprint(BASE);
  const comparedAfterUnsend = computeEvidenceFingerprint({ ...BASE, composeBasis: COMPOSE });
  check("unsend · evidence-only stamp vs compose compare = guaranteed rebuild", stampedAtSend !== comparedAfterUnsend);
  const decision = decideDriftAction({
    storedFingerprint: stampedAtSend,
    currentFingerprint: comparedAfterUnsend,
    sentAt: null, // unsend cleared it
    cooldownUntil: null,
    lastRefreshAt: null,
    debounceMinutes: 0,
  });
  check("unsend · and the decision is regenerate_draft", decision.action === "regenerate_draft", decision);
}

console.log(`\ndraft-live-rebuild fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
