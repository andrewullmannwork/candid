/**
 * letter-needs — S301. Locks WHAT EACH LETTER ASKS THE USER FOR.
 *
 * The defect family this closes had ONE root: the gap emitter and the MVDL
 * readiness floor each re-derived the recipient with `letterType !==
 * "insurance_appeal"`, while the letter composer (index.ts) and the templates
 * had already decided it correctly. Consequences, all live before this fixture:
 *
 *   - debt_validation was asked for a PROVIDER address it never prints, and
 *     scored "Not ready to send" for missing it (defects #2/#3/#5)
 *   - external_review was asked for a provider address and NEVER for the
 *     appeals address it must be mailed to (defect #4)
 *   - the legal Case File's "What Would Strengthen This" printed those same
 *     irrelevant items (defect #6)
 *   - a raw `external_appeal` dispute_type missed letterRecipientKind's lookup
 *     entirely and defaulted to "provider" — and BOTH the [disputeId] GET and
 *     the case-file route pass the raw dispute_type in
 *
 * So this asserts the full 9-type matrix, the legacy aliases, and the null
 * case — the last one because `letterRecipientKind(null)` returns "provider",
 * so routing a null straight through would newly DEMAND a provider address on
 * every letterType-less call (the pre-S301 binary guarded on `!== null`).
 *
 * Run:  npx tsx scripts/calibration/fixtures/dispute-grounds/letter-needs.ts
 */
import {
  letterNeeds,
  letterRecipientKind,
  normalizeLetterType,
  recipientAddressGapKindFor,
  type LetterNeedKey,
} from "../../../../src/lib/disputes/letter-type";
import { appealsConfirmCopy } from "../../../../src/components/disputes/DisputeRecipientCard";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}${got !== undefined ? `  (got: ${JSON.stringify(got)})` : ""}`);
}

// ── 1. The full matrix, all nine letter types ───────────────────────────────
const MATRIX: Array<{
  type: string;
  kind: "insurer" | "provider" | "collector";
  address: LetterNeedKey;
  needs: LetterNeedKey[];
}> = [
  {
    type: "insurance_appeal",
    kind: "insurer",
    address: "insurer_appeals_address",
    needs: ["insurer_appeals_address", "denial_date", "eob_detail"],
  },
  {
    type: "external_review",
    kind: "insurer",
    address: "insurer_appeals_address",
    needs: ["insurer_appeals_address", "eob_detail"],
  },
  {
    type: "debt_validation",
    kind: "collector",
    address: "collector_address",
    needs: ["collector_address", "collector_first_contact_date", "account_number"],
  },
  {
    type: "overcharge",
    kind: "provider",
    address: "provider_address",
    needs: ["provider_address", "eob_detail"],
  },
  {
    type: "balance_billing",
    kind: "provider",
    address: "provider_address",
    needs: ["provider_address", "eob_detail"],
  },
  {
    type: "duplicate_charge",
    kind: "provider",
    address: "provider_address",
    needs: ["provider_address", "eob_detail"],
  },
  {
    type: "itemized_request",
    kind: "provider",
    address: "provider_address",
    needs: ["provider_address", "eob_detail"],
  },
  {
    type: "negotiation",
    kind: "provider",
    address: "provider_address",
    needs: ["provider_address", "eob_detail"],
  },
  {
    type: "final_notice",
    kind: "provider",
    address: "provider_address",
    needs: ["provider_address", "eob_detail"],
  },
];

for (const row of MATRIX) {
  const n = letterNeeds(row.type);
  check(`${row.type} · recipientKind = ${row.kind}`, n.recipientKind === row.kind, n.recipientKind);
  check(
    `${row.type} · prints ${row.address}`,
    n.recipientAddress === row.address,
    n.recipientAddress,
  );
  check(
    `${row.type} · needs = [${row.needs.join(", ")}]`,
    JSON.stringify(n.needs) === JSON.stringify(row.needs),
    n.needs,
  );
}

// ── 2. The defects, stated as the negatives that used to be true ────────────
{
  const dv = letterNeeds("debt_validation");
  check(
    "defect #2/#3 · debt_validation NEVER asks for a provider address",
    !dv.needs.includes("provider_address"),
    dv.needs,
  );
  check(
    "defect #3 · debt_validation NEVER asks for EOB detail",
    !dv.needs.includes("eob_detail"),
    dv.needs,
  );
  check(
    "debt_validation asks for the collector's account number",
    dv.needs.includes("account_number"),
    dv.needs,
  );

  const xr = letterNeeds("external_review");
  check(
    "defect #4 · external_review NEVER asks for a provider address",
    !xr.needs.includes("provider_address"),
    xr.needs,
  );
  check(
    "defect #4 · external_review DOES ask for the appeals address",
    xr.needs.includes("insurer_appeals_address"),
    xr.needs,
  );

  // denial_date is insurance_appeal ONLY: its sole functional consumer is the
  // deadline engine's erisa_appeal_180 (its own track set is ["insurance_appeal"])
  // and no template reads it. external_review's denial date is a DIFFERENT field
  // (appealExhausted.denialDate, from the exhaustion attestation).
  check("denial_date · asked on insurance_appeal", letterNeeds("insurance_appeal").needs.includes("denial_date"));
  check("denial_date · NOT asked on external_review", !xr.needs.includes("denial_date"), xr.needs);
  check(
    "denial_date · NOT asked on final_notice",
    !letterNeeds("final_notice").needs.includes("denial_date"),
  );
}

// ── 3. Legacy raw dispute_type aliases ──────────────────────────────────────
{
  check("alias · internal_appeal → insurance_appeal", normalizeLetterType("internal_appeal") === "insurance_appeal");
  check("alias · external_appeal → external_review", normalizeLetterType("external_appeal") === "external_review");
  check("alias · complaint → balance_billing", normalizeLetterType("complaint") === "balance_billing");
  check("alias · unknown passes through", normalizeLetterType("overcharge") === "overcharge");

  // THE live bug: both the [disputeId] GET and the case-file route pass the raw
  // dispute_type, and `external_appeal` used to fall through to "provider".
  check(
    "raw external_appeal · recipientKind = insurer (was provider)",
    letterRecipientKind("external_appeal") === "insurer",
    letterRecipientKind("external_appeal"),
  );
  check(
    "raw external_appeal · asks for the appeals address",
    letterNeeds("external_appeal").needs.includes("insurer_appeals_address"),
    letterNeeds("external_appeal").needs,
  );
  check(
    "raw internal_appeal · gets denial_date (normalized first)",
    letterNeeds("internal_appeal").needs.includes("denial_date"),
    letterNeeds("internal_appeal").needs,
  );
  // Pre-existing raw insurer types keep resolving through INSURER_DISPUTE_TYPES.
  for (const t of ["cost_share_misapplication", "coverage_contradiction", "not_covered"]) {
    check(`raw ${t} · recipientKind = insurer`, letterRecipientKind(t) === "insurer", letterRecipientKind(t));
  }
}

// ── 4. Null / absent letter type — NO address requirement ───────────────────
{
  for (const empty of [null, undefined, ""]) {
    const n = letterNeeds(empty as string | null | undefined);
    check(`null-ish (${JSON.stringify(empty)}) · recipientKind null`, n.recipientKind === null, n.recipientKind);
    check(`null-ish (${JSON.stringify(empty)}) · no address floor`, n.recipientAddressGapKind === null);
    check(`null-ish (${JSON.stringify(empty)}) · asks for nothing`, n.needs.length === 0, n.needs);
  }
}

// ── 5. ONE source: the gap kind the panel asks for IS the one scoring uses ──
{
  for (const row of MATRIX) {
    const n = letterNeeds(row.type);
    check(
      `${row.type} · gap kind matches recipientAddressGapKindFor`,
      n.recipientAddressGapKind === recipientAddressGapKindFor(row.kind),
      n.recipientAddressGapKind,
    );
    // The address it asks for and the gap it scores can never disagree.
    const expectedGap =
      row.address === "insurer_appeals_address"
        ? "insurer_address_missing"
        : row.address === "collector_address"
          ? "collector_address_missing"
          : "provider_address_missing";
    check(
      `${row.type} · asked address ↔ scored gap agree`,
      n.recipientAddressGapKind === expectedGap,
      n.recipientAddressGapKind,
    );
  }
}

// ── 6. Cascade copy — the exact approved strings, both provenances ──────────
//
// The cross-dispute appeals-address REUSE overlay already shipped (S266); what
// S301 adds is provenance, so the prompt can say where the value came from. The
// two cases must never render each other's copy: showing "Last verified «date»"
// on a value the USER typed on another bill claims a Candid verification that
// never happened, and the date would belong to a different bill.
{
  const carried = appealsConfirmCopy({
    carriedFromPriorDispute: true,
    insurerName: "Providence",
    lastVerified: "Jul 12, 2026",
  });
  check(
    "carried · prompt names the insurer + the earlier bill (Andrew-approved)",
    carried.prompt === "You used this address for Providence on an earlier bill. Still correct?",
    carried.prompt,
  );
  check("carried · confirm label = Use this", carried.confirmLabel === "Use this", carried.confirmLabel);
  check("carried · change label = Change", carried.changeLabel === "Change", carried.changeLabel);
  check(
    "carried · NEVER claims a verification date",
    !carried.prompt.includes("verified") && !carried.prompt.includes("Jul 12"),
    carried.prompt,
  );

  const catalog = appealsConfirmCopy({
    carriedFromPriorDispute: false,
    insurerName: "Providence",
    lastVerified: "Jul 12, 2026",
  });
  check(
    "catalog · keeps the Block C2.2 prompt unchanged",
    catalog.prompt === "Last verified Jul 12, 2026. Is this the right appeals address?",
    catalog.prompt,
  );
  check("catalog · confirm label = Looks right", catalog.confirmLabel === "Looks right", catalog.confirmLabel);
  check("catalog · change label = Not correct", catalog.changeLabel === "Not correct", catalog.changeLabel);
  check(
    "the two provenances never share copy",
    carried.prompt !== catalog.prompt &&
      carried.confirmLabel !== catalog.confirmLabel &&
      carried.changeLabel !== catalog.changeLabel,
  );
}

console.log(`\nletter-needs fixture: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  console.log("FAILED ✗");
  process.exit(1);
}
console.log("ALL GREEN ✓");
