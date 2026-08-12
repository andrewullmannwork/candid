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
  driftMachineryApplies,
  type FingerprintInput,
  type ComposeBasis,
  type ComposeProfileFacts,
} from "../../../../src/lib/disputes/evidence-fingerprint";
import {
  letterPatientName,
  letterPatientIdentityFromMeta,
  isLiveDraftStatus,
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
  // S311 — the profile/plan compose facts (tree 13.5)
  profileAddressLine1: "456 Oak Ave",
  profileAddressLine2: null,
  profileCity: "Pittsburg",
  profileState: "WA",
  profileZip: "87726",
  profilePlanSource: "employer",
  accountHolderName: "Andrew Ullmann",
  accountHolderEmail: "andrew@example.com",
  planInsurerName: "Blue Cross Blue Shield of Wyoming",
  planName: "Blue Choice PPO",
  planYear: 2026,
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

// ── 6. Void rows are read-only exhibits (S308) ──────────────────────────────
// The E2E corpse: a CANCELLED draft has null sent_at, so the sent-only guard
// counted it as an unsent draft and a plain view silently rebuilt it. The rule,
// stated once: only a live draft recomposes; sent letters keep banners; every
// other status freezes the stored body. isLiveDraftStatus is a fail-closed
// WHITELIST — a future status word defaults to frozen, never to rewritable.
{
  check("void · the draft status is the ONLY live one", isLiveDraftStatus("dispute_letter_drafted"));
  for (const s of [
    "cancelled",
    "won",
    "lost",
    "settled",
    "withdrawn",
    "won_on_escalation",
    "settled_on_escalation",
    "filed",
    "in_progress",
    "resolved",
  ]) {
    check(`void · "${s}" is not a live draft`, !isLiveDraftStatus(s));
  }
  check("void · null/undefined fail closed", !isLiveDraftStatus(null) && !isLiveDraftStatus(undefined));

  // the apparatus gate: live drafts and sent rows participate; void rows never
  const sent = new Date("2026-08-05T18:00:00Z");
  check("apparatus · live draft (unsent) participates", driftMachineryApplies("dispute_letter_drafted", null));
  check("apparatus · sent letter participates (drift banner)", driftMachineryApplies("filed", sent));
  check("apparatus · resolved-after-send still participates (banner axis)", driftMachineryApplies("lost", sent));
  check("apparatus · cancelled + never sent = void, no apparatus", !driftMachineryApplies("cancelled", null));
  check("apparatus · resolved without a send = void, no apparatus", !driftMachineryApplies("lost", null));

  // the corpse scenario end-to-end in the pure layer: cancelled + real compose
  // drift → the apparatus gate refuses BEFORE any drift decision exists
  const stored = computeEvidenceFingerprint(BASE);
  const drifted = computeEvidenceFingerprint({ ...BASE, composeBasis: COMPOSE });
  check("corpse · the drift is real (hashes differ)", stored !== drifted);
  check("corpse · and the void gate still refuses the apparatus", !driftMachineryApplies("cancelled", null));
}

// ── 7. S311 (tree 13.5) — the profile/plan compose facts drift the hash ─────
// Andrew's mailing-address edit never reached his draft: the rebuild decision
// compares the evidence fingerprint, and nothing profile-sourced was in it.
// Each sibling of that class, pinned: a lone edit to any of these MUST drift.
{
  const before = computeEvidenceFingerprint({ ...BASE, composeBasis: COMPOSE });
  const cases: Array<[string, Partial<ComposeBasis>]> = [
    ["the mailing address (line1)", { profileAddressLine1: "999 Real St" }],
    ["the address line2 alone", { profileAddressLine2: "Suite 2" }],
    ["the city alone", { profileCity: "Seattle" }],
    ["the profile STATE (the DOI/AG clause input)", { profileState: "CA" }],
    ["the zip alone", { profileZip: "98101" }],
    ["the funding type (the ERISA gate)", { profilePlanSource: "marketplace" }],
    ["the account-holder name (the patient line)", { accountHolderName: "A. D. Ullmann" }],
    ["the account email (name fallback)", { accountHolderEmail: "new@example.com" }],
    ["the plan's insurer name (the recipient block)", { planInsurerName: "Premera Blue Cross" }],
    ["the plan's display name (the citation line)", { planName: "Blue Choice HMO" }],
    ["the plan year (the citation line)", { planYear: 2025 }],
  ];
  for (const [label, patch] of cases) {
    const after = computeEvidenceFingerprint({
      ...BASE,
      composeBasis: { ...COMPOSE, ...patch },
    });
    check(`profile-facts · ${label} alone drifts the hash`, after !== before);
  }

  // mapping: raw facts → basis fields (trim; blank ≡ missing; numeric year)
  const FACTS: ComposeProfileFacts = {
    addressLine1: " Test User Address ",
    addressLine2: "   ",
    city: "Test",
    state: "CA",
    zip: "94530",
    planSource: null,
    accountHolderName: "Andrew Ullmann",
    accountHolderEmail: null,
    planInsurerName: " Blue Cross Blue Shield of Wyoming ",
    planName: null,
    planYear: 2026,
  };
  const mapped = composeBasisFrom(null, null, FACTS);
  check(
    "profile-facts · mapping trims + blank≡missing",
    mapped.profileAddressLine1 === "Test User Address" &&
      mapped.profileAddressLine2 === null &&
      mapped.profileState === "CA" &&
      mapped.planInsurerName === "Blue Cross Blue Shield of Wyoming" &&
      mapped.planYear === 2026,
    mapped,
  );
  check(
    "profile-facts · absent facts ≡ all-null facts (one representation of empty)",
    JSON.stringify(composeBasisFrom(null, null)) ===
      JSON.stringify(
        composeBasisFrom(null, null, {
          addressLine1: null,
          addressLine2: "  ",
          city: null,
          state: null,
          zip: null,
          planSource: null,
          accountHolderName: null,
          accountHolderEmail: null,
          planInsurerName: null,
          planName: null,
          planYear: null,
        }),
      ),
  );
  // the sent shape stays evidence-only: profile facts can never false-flag a
  // sent letter (same guarantee as check 5, reasserted with facts present)
  const sentStamp = computeEvidenceFingerprint(BASE);
  const draftCompare = computeEvidenceFingerprint({ ...BASE, composeBasis: COMPOSE });
  check("profile-facts · sent stamp untouched by profile facts", sentStamp !== draftCompare);
}

console.log(`\ndraft-live-rebuild fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
