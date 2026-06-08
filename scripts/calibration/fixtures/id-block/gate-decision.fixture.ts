/**
 * ID-Block PR2 gate-decision fixture (Ship Gate G4).
 *
 * Locks the pure decision the live hook depends on:
 *   - decideQuarantineAction: wouldFlag × mode → {hold, state, slackWorthy}
 *     · not flagged            → shadow, no hold, no Slack
 *     · flagged + shadow mode  → shadow, no hold, Slack (measure, hold nothing)
 *     · flagged + active mode  → held,  hold,    Slack
 *   - buildSlackMessageText: held vs shadow framing + trigger rendering.
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/id-block/gate-decision.fixture.ts
 *
 * Pass criteria: all cases PASS. Exit 0 on PASS, 1 on any failure.
 */

import { decideQuarantineAction } from "../../../../src/lib/parser/id-block/gate";
import { buildSlackMessageText } from "../../../../src/lib/parser/id-block/slack";
import type { ClusterLegitimacyResult } from "../../../../src/lib/parser/id-block/types";

function result(wouldFlag: boolean): ClusterLegitimacyResult {
  return {
    clusterScore: wouldFlag ? 0.1 : 0.9,
    shape: { medianScore: 0.1, uniformlyThin: wouldFlag, temporalBurst: wouldFlag, signupCorrelated: wouldFlag },
    sameContent: wouldFlag,
    novelCanonical: false,
    sameContentReplay: wouldFlag,
    novelLowLegitimacy: false,
    wouldFlag,
    reasons: wouldFlag ? ["same-document replay"] : [],
  };
}

interface Case {
  name: string;
  run: () => boolean;
  detail?: () => string;
}

const cases: Case[] = [
  {
    name: "not flagged → shadow, no hold, no Slack (regardless of mode)",
    run: () => {
      const a = decideQuarantineAction(result(false), "active");
      return !a.hold && a.state === "shadow" && !a.slackWorthy;
    },
  },
  {
    name: "flagged + shadow mode → shadow state, NO hold, Slack fires (measure, hold nothing)",
    run: () => {
      const a = decideQuarantineAction(result(true), "shadow");
      return !a.hold && a.state === "shadow" && a.slackWorthy;
    },
    detail: () => JSON.stringify(decideQuarantineAction(result(true), "shadow")),
  },
  {
    name: "flagged + active mode + NOT already promoted → held state, hold=true, Slack fires",
    run: () => {
      const a = decideQuarantineAction(result(true), "active", false);
      return a.hold && a.state === "held" && a.slackWorthy;
    },
    detail: () => JSON.stringify(decideQuarantineAction(result(true), "active", false)),
  },
  {
    name: "S175 D5: flagged + active mode + ALREADY promoted → shadow, NO hold, Slack still fires",
    run: () => {
      const a = decideQuarantineAction(result(true), "active", true);
      // sticky promotion means a hold would withhold nothing → record shadow, not held.
      return !a.hold && a.state === "shadow" && a.slackWorthy;
    },
    detail: () => JSON.stringify(decideQuarantineAction(result(true), "active", true)),
  },
  {
    name: "S175 D5: default alreadyPromoted=false preserves prior behavior (active+flagged → held)",
    run: () => {
      const a = decideQuarantineAction(result(true), "active");
      return a.hold && a.state === "held";
    },
  },
  {
    name: "Slack text: held state → HELD framing",
    run: () => {
      const t = buildSlackMessageText({
        quarantineId: "q1",
        canonicalPlanId: "c1",
        documentType: "sbc",
        mode: "active",
        state: "held",
        clusterScore: 0.12,
        clusterSize: 3,
        sameContent: true,
        novelCanonical: false,
        scaleTier: "cold_start",
        reasons: ["same-document replay"],
      });
      return t.includes("HELD") && t.includes("same-content replay") && t.includes("cold_start");
    },
  },
  {
    name: "Slack text: shadow state → would-flag framing + novel trigger rendered",
    run: () => {
      const t = buildSlackMessageText({
        quarantineId: null,
        canonicalPlanId: "c2",
        documentType: "eoc",
        mode: "shadow",
        state: "shadow",
        clusterScore: 0.2,
        clusterSize: 4,
        sameContent: false,
        novelCanonical: true,
        scaleTier: "small",
        reasons: ["novel canonical with low-legitimacy cluster"],
      });
      return t.includes("would-flag") && t.includes("novel canonical");
    },
  },
];

let failed = 0;
for (const c of cases) {
  let ok = false;
  let err = "";
  try {
    ok = c.run();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const extra = c.detail && (!ok || process.env.VERBOSE) ? `  [${c.detail()}]` : "";
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${extra}${err ? `  (threw: ${err})` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
