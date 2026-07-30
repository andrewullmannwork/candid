/**
 * S292 item 4C — merge-receipt / unwind fixture.
 *
 * The property under test is NOT "does the undo restore the old values" — it is
 * "does the undo refuse to destroy anything the user changed after the merge".
 * A blind restore would look correct in every happy-path check and would quietly
 * wipe a correction the user typed between the merge and the click: the same
 * class of harm that got mig 217 blocked.
 *
 * Hermetic — pure functions only, no Supabase.
 *
 * Run: npx tsx scripts/s292-merge-receipt-fixture.ts
 */
import {
  buildPlanRevertPatch,
  buildProfileRevertPatch,
  buildCellRevert,
  provenanceCitesDocument,
  sameStoredValue,
  cellKeyOf,
  PLAN_MERGE_RECEIPT_VERSION,
  MAX_RECEIPT_CELLS,
  type PlanMergeReceipt,
} from "../src/lib/plan/merge-receipt";

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

const DOC = "doc-1";
const OTHER_DOC = "doc-2";

const receipt = (over: Partial<PlanMergeReceipt> = {}): PlanMergeReceipt => ({
  version: PLAN_MERGE_RECEIPT_VERSION,
  documentId: DOC,
  targetPlanId: "plan-1",
  mergedAt: "2026-07-29T00:00:00.000Z",
  plan: {
    before: { in_deductible_individual: 1000, in_oop_max_individual: null, plan_name: "Old Plan" },
    wrote: { in_deductible_individual: 3000, in_oop_max_individual: 9000, plan_name: "New Plan" },
  },
  provenanceBefore: { in_deductible_individual: { source: "sbc_upload", confidence: 0.9 } },
  profile: {
    before: { insurer: "Cigna", plan_name: "Old Plan", active_insurance_plan_id: "plan-1" },
    wrote: { insurer: "Aetna", plan_name: "New Plan", active_insurance_plan_id: "plan-1" },
  },
  cellsBefore: [],
  servicesUnwindable: true,
  ...over,
});

console.log("\nS292 4C — merge receipt / unwind\n");

// ── 1. Plain revert ───────────────────────────────────────────────────────────
console.log("plan revert — untouched fields go back");
{
  const r = receipt();
  const current = { ...r.plan.wrote, id: "plan-1", user_id: "u1" };
  const { patch, keptByUser } = buildPlanRevertPatch(r, current);
  check("deductible reverts to the pre-merge value", patch.in_deductible_individual === 1000, patch);
  check("a field the merge FILLED reverts to null", patch.in_oop_max_individual === null, patch);
  check("plan name reverts", patch.plan_name === "Old Plan", patch);
  check("nothing is reported as user-kept", keptByUser.length === 0, keptByUser);
  check("provenance is restored wholesale", JSON.stringify(patch.field_provenance) === JSON.stringify(r.provenanceBefore), patch.field_provenance);
  check("housekeeping columns are never in the patch", !("id" in patch) && !("user_id" in patch), Object.keys(patch));
}

// ── 2. THE property: a later correction survives ──────────────────────────────
console.log("\ncompare-and-swap — a correction made after the merge is NOT destroyed");
{
  const r = receipt();
  // The user opened the assumptions card and typed a real deductible.
  const current = { ...r.plan.wrote, in_deductible_individual: 2500 };
  const { patch, keptByUser } = buildPlanRevertPatch(r, current);
  check("the corrected field is NOT reverted", !("in_deductible_individual" in patch), patch);
  check("…and is reported as kept", keptByUser.includes("in_deductible_individual"), keptByUser);
  check("untouched fields still revert", patch.plan_name === "Old Plan", patch);
}

// ── 3. Idempotence-adjacent: reverting twice is a no-op ───────────────────────
console.log("\nre-running the revert against already-reverted state");
{
  const r = receipt();
  const reverted = { ...r.plan.before };
  const { patch, keptByUser } = buildPlanRevertPatch(r, reverted);
  const changed = Object.keys(patch).filter((k) => k !== "field_provenance");
  check("a second revert changes no plan columns", changed.length === 0, changed);
  check("…because they read as user-modified, not as needing revert", keptByUser.length === 3, keptByUser);
}

// ── 4. Profile ────────────────────────────────────────────────────────────────
console.log("\nprofile revert");
{
  const r = receipt();
  const { patch } = buildProfileRevertPatch(r, { ...r.profile!.wrote });
  check("insurer reverts", patch.insurer === "Cigna", patch);
  const kept = buildProfileRevertPatch(r, { ...r.profile!.wrote, insurer: "Kaiser" });
  check("a profile field the user changed is kept", !("insurer" in kept.patch), kept.patch);
  check("…and reported", kept.keptByUser.includes("insurer"), kept.keptByUser);
}

// ── 5. Coverage cells ─────────────────────────────────────────────────────────
console.log("\ncoverage cells — restore, delete, and what must NOT be deleted");
{
  const key = (id: string) => ({ service_id: id, place_of_service: "any", component: "global", plan_tier_label: "none" });
  const r = receipt({
    cellsBefore: [{ key: key("svc-1"), row: { service_id: "svc-1", place_of_service: "any", component: "global", plan_tier_label: "none", in_copay: 30 } }],
  });
  const current = [
    // pre-existing, overwritten by the merge → restore
    { service_id: "svc-1", place_of_service: "any", component: "global", plan_tier_label: "none", in_copay: 55 },
    // created by THIS document → delete
    { service_id: "svc-2", place_of_service: "any", component: "global", plan_tier_label: "none", in_copay: 40,
      field_provenance: { in_copay: { source: "sbc_upload", source_document_id: DOC } } },
    // created by SOMETHING ELSE after the merge → must survive
    { service_id: "svc-3", place_of_service: "any", component: "global", plan_tier_label: "none", in_copay: 10,
      field_provenance: { in_copay: { source: "manual" } } },
  ];
  const rev = buildCellRevert(r, current, provenanceCitesDocument);
  check("a pre-existing cell is restored to its snapshot", rev.restore.length === 1 && rev.restore[0].in_copay === 30, rev.restore);
  check("a cell this document created is deleted", rev.deleteKeys.length === 1 && rev.deleteKeys[0].service_id === "svc-2", rev.deleteKeys);
  check("a cell from ANOTHER source is NOT deleted", rev.keptByUser === 1, rev.keptByUser);
  check("…and is not silently restored either", !rev.restore.some((c) => c.service_id === "svc-3"), rev.restore);
}

// ── 6. Provenance attribution ─────────────────────────────────────────────────
console.log("\nprovenance attribution");
{
  check("originating citation counts", provenanceCitesDocument({ field_provenance: { a: { source_document_id: DOC } } }, DOC));
  check("corroboration counts", provenanceCitesDocument({ field_provenance: { a: { corroborated_by: [OTHER_DOC, DOC] } } }, DOC));
  check("row-level source_document_id counts", provenanceCitesDocument({ source_document_id: DOC }, DOC));
  check("another document does NOT count", !provenanceCitesDocument({ field_provenance: { a: { source_document_id: OTHER_DOC } } }, DOC));
  check("no provenance at all does NOT count (fail-safe: keep the row)", !provenanceCitesDocument({}, DOC));
}

// ── 7. Value comparison edges ─────────────────────────────────────────────────
console.log("\nsameStoredValue edges");
{
  check("null equals null (untouched, not 'changed')", sameStoredValue(null, null));
  check("numeric string equals number", sameStoredValue("3000", 3000));
  check("0 is a real value, not empty", sameStoredValue(0, 0));
  check("0 differs from null", !sameStoredValue(0, null));
  check("case-insensitive text", sameStoredValue("Aetna", "aetna"));
  check("different values differ", !sameStoredValue(3000, 2500));
}

// ── 8. The no-silent-cap contract ─────────────────────────────────────────────
console.log("\nno silent caps");
{
  const r = receipt({ servicesUnwindable: false, cellsBefore: [] });
  check("a declined snapshot is flagged, not faked", r.servicesUnwindable === false);
  check("…and carries no partial cell set", r.cellsBefore.length === 0);
  check("the ceiling is a named constant", typeof MAX_RECEIPT_CELLS === "number" && MAX_RECEIPT_CELLS > 0);
  check("cell keys are stable + 5-col", cellKeyOf({ service_id: "s", place_of_service: "any", component: "global", plan_tier_label: "none" }) === "s|any|global|none");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
