/**
 * Cost-Share v2 (W3) — cost-share-override body parser/validator fixtures.
 * Locks the field discrimination, the coinsurance %→decimal normalization, and the
 * validation guards (asOf-only-when-met, range checks, required fields).
 * Run: npx tsx scripts/calibration/fixtures/cost-share-v2/override-parse.ts
 */
import { parseCostShareOverride } from "../../../../src/lib/claims/cost-share-override";

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) pass++;
  else fails.push(`✗ ${name}  got=${JSON.stringify(got)}`);
}
const ok = (b: unknown) => parseCostShareOverride(b);

// network
{
  const r = ok({ field: "network", value: "out_of_network" });
  check("network valid", r.ok && r.value.field === "network" && r.value.value === "out_of_network", r);
  check("network invalid value", !ok({ field: "network", value: "tiered" }).ok);
}

// met-status
{
  const r = ok({ field: "deductible_met", met: true, asOf: "2026-03-01" });
  check("deductible_met + asOf", r.ok && r.value.field === "deductible_met" && r.value.met === true && r.value.asOf === "2026-03-01", r);
  check("deductible_met missing met", !ok({ field: "deductible_met" }).ok);
  check("met false + asOf rejected", !ok({ field: "deductible_met", met: false, asOf: "2026-03-01" }).ok);
  check("bad date rejected", !ok({ field: "oop_met", met: true, asOf: "March 1" }).ok);
  const r2 = ok({ field: "oop_met", met: false });
  check("oop_met false no asOf", r2.ok && r2.value.field === "oop_met" && r2.value.met === false && r2.value.asOf === null, r2);
}

// service_cost
{
  const r = ok({ field: "service_cost", serviceSlug: "annual_physical", copay: 20.5 });
  check("service_cost copay", r.ok && r.value.field === "service_cost" && r.value.copay === 20.5 && r.value.coinsurance === null, r);
  const r2 = ok({ field: "service_cost", serviceSlug: "specialist_visit", coinsurancePercent: 30 });
  check("coinsurance % → decimal 0.3", r2.ok && r2.value.field === "service_cost" && r2.value.coinsurance === 0.3, r2);
  check("coinsurance > 100 rejected", !ok({ field: "service_cost", serviceSlug: "x", coinsurancePercent: 150 }).ok);
  check("negative copay rejected", !ok({ field: "service_cost", serviceSlug: "x", copay: -5 }).ok);
  check("no copay/coins rejected", !ok({ field: "service_cost", serviceSlug: "x" }).ok);
  check("missing serviceSlug rejected", !ok({ field: "service_cost", copay: 10 }).ok);
  const r3 = ok({ field: "service_cost", serviceSlug: "x", copay: 0, deductibleApplies: false });
  check("copay 0 + deductibleApplies false", r3.ok && r3.value.field === "service_cost" && r3.value.copay === 0 && r3.value.deductibleApplies === false, r3);
}

// aca
{
  const r = ok({ field: "aca", status: "confirmed" });
  check("aca confirmed", r.ok && r.value.field === "aca" && r.value.status === "confirmed", r);
  check("aca bad status", !ok({ field: "aca", status: "maybe" }).ok);
}

// guards
check("unknown field rejected", !ok({ field: "premium" }).ok);
check("null body rejected", !ok(null).ok);
check("non-object rejected", !ok("network").ok);


// S308 — deductible-applies-only correction (the banner's inline Yes/No when
// the rate is already stated) is a legitimate partial write.
{
  const r = ok({ field: "service_cost", serviceSlug: "acupuncture", deductibleApplies: true });
  check("service_cost dedApplies-only parses", r.ok && r.value.field === "service_cost" && r.value.deductibleApplies === true && r.value.copay === null && r.value.coinsurance === null, r);
  check("service_cost dedApplies-only false parses", ok({ field: "service_cost", serviceSlug: "acupuncture", deductibleApplies: false }).ok);
  check("service_cost still rejects the EMPTY correction", !ok({ field: "service_cost", serviceSlug: "acupuncture" }).ok);
}


// S308 — the verify-card's persisted reviewed/collapsed state.
{
  const r = ok({ field: "assumptions_reviewed", reviewed: true });
  check("assumptions_reviewed true parses", r.ok && r.value.field === "assumptions_reviewed" && r.value.reviewed === true, r);
  check("assumptions_reviewed false parses", ok({ field: "assumptions_reviewed", reviewed: false }).ok);
  check("assumptions_reviewed non-boolean rejected", !ok({ field: "assumptions_reviewed", reviewed: "yes" }).ok);
}


// S308 round 2 — deductibleApplies is THREE-VALUED: absent = untouched ·
// explicit null = CLEAR the stored answer ("I'm not sure" after a saved
// Yes/No) · boolean = set.
{
  const rSet = ok({ field: "service_cost", serviceSlug: "acupuncture", deductibleApplies: true });
  check("dedApplies set parses touched", rSet.ok && rSet.value.field === "service_cost" && rSet.value.deductibleApplies === true && rSet.value.deductibleAppliesTouched === true, rSet);
  const rClear = ok({ field: "service_cost", serviceSlug: "acupuncture", deductibleApplies: null });
  check("dedApplies explicit-null parses as touched CLEAR", rClear.ok && rClear.value.field === "service_cost" && rClear.value.deductibleApplies === null && rClear.value.deductibleAppliesTouched === true, rClear);
  const rAbsent = ok({ field: "service_cost", serviceSlug: "acupuncture", copay: 20 });
  check("dedApplies absent parses untouched", rAbsent.ok && rAbsent.value.field === "service_cost" && rAbsent.value.deductibleAppliesTouched === false, rAbsent);
  check("clear-only body is a legal partial write", ok({ field: "service_cost", serviceSlug: "acupuncture", deductibleApplies: null }).ok);
  check("empty body still rejected", !ok({ field: "service_cost", serviceSlug: "acupuncture" }).ok);
  check("non-boolean non-null still rejected", !ok({ field: "service_cost", serviceSlug: "acupuncture", deductibleApplies: "yes" }).ok);
}

console.log(`\ncost-share-v2 override-parse fixtures: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("ALL GREEN ✓");
