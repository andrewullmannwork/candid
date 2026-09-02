/**
 * dfy-state-lanes — S330. Locks the per-state DFY lane registry, the way the
 * citation registry is locked: legally-gated data changes only via a reviewed
 * PR, and this fixture is what a PR must satisfy.
 *
 *   1. every US state + DC has a row, with a date-only verifiedOn
 *   2. exactly ONE state is open (CA, pilot); every other row is closed
 *   3. CA carries the DFPI regime and is NOT registered (stay-dark, R15)
 *   4. NEGOTIATION_GEO_GATED_STATES derives to exactly ["CA"] — the ONE fact
 *      the letter geo-gate and the paid-lane check both read
 *   5. laneFor normalizes ("ca", " Ca ") and refuses junk; unknown = closed
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/dfy-state-lanes.ts
 */
import {
  STATE_LANES,
  NEGOTIATION_GEO_GATED_STATES,
  laneFor,
  dfyLaneOpen,
  normalizeStateCode,
} from "../../../../src/lib/dfy/state-lanes";
import { GEO_GATED_LETTER_TYPES } from "../../../../src/lib/disputes/letter-access";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

const rows = Object.values(STATE_LANES);
check("51 rows (50 states + DC)", rows.length === 51);
check("every row keyed by its own state code", rows.every((r) => STATE_LANES[r.state] === r));
check("every row has a date-only verifiedOn", rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.verifiedOn)));
check("every row is the insurer lane", rows.every((r) => r.lane === "insurer"));
const open = rows.filter((r) => r.status === "pilot");
check("exactly one open state", open.length === 1);
check("the open state is CA", open[0]?.state === "CA");
check("CA carries the DFPI regime", STATE_LANES.CA.dfpiRegime === true);
check("CA is NOT DFPI-registered (stay dark)", STATE_LANES.CA.dfpiRegistered === false);
check("no closed state claims a regime", rows.filter((r) => r.status === "closed").every((r) => !r.dfpiRegime && !r.dfpiRegistered));
check("NEGOTIATION_GEO_GATED_STATES is exactly [CA]", JSON.stringify([...NEGOTIATION_GEO_GATED_STATES]) === JSON.stringify(["CA"]));
check("the letter geo-gate reads the registry's list", GEO_GATED_LETTER_TYPES.negotiation?.states === NEGOTIATION_GEO_GATED_STATES);
check("normalizeStateCode(' ca ') → CA", normalizeStateCode(" ca ") === "CA");
check("normalizeStateCode('California') → null", normalizeStateCode("California") === null);
check("laneFor('ca') is the CA row", laneFor("ca") === STATE_LANES.CA);
check("laneFor(null) is null", laneFor(null) === null);
check("dfyLaneOpen('CA') true", dfyLaneOpen("CA") === true);
check("dfyLaneOpen('TX') false", dfyLaneOpen("TX") === false);
check("dfyLaneOpen(undefined) false (unknown = closed)", dfyLaneOpen(undefined) === false);
check("registry is frozen", Object.isFrozen(STATE_LANES));

console.log(`dfy-state-lanes: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
