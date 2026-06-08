/**
 * ID-Block admin work-list inventory fixture (Ship Gate G4 — PR3a).
 *
 * Locks the PURE assembly math the §4 work-list renders (the IO gather is proven by
 * the synthetic-row E2E):
 *   - summarizeMemberScores: §4.2 legitimacy distribution (min/median/max + % below
 *     bar + uniformly-thin), incl. the empty cluster + the strict-`<` boundary,
 *   - trustTier: the §4.1 verification-tier mapping (the verification-mix tally),
 *   - toBaselineTuple: the live re-eval's tuple coercion (number/null/missing/string),
 *   - cross-module invariant: scoreUserLegitimacy.contributions SUM to the score the
 *     admin sees (the §4.1 "which signal added what" breakdown is honest).
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/id-block/inventory.fixture.ts
 *
 * Pass criteria: all cases PASS. Exit 0 on PASS, 1 on any failure.
 */

import {
  summarizeMemberScores,
  trustTier,
  toBaselineTuple,
} from "../../../../src/lib/parser/id-block/inventory";
import { scoreUserLegitimacy } from "../../../../src/lib/parser/id-block/cluster-legitimacy";
import { DEFAULT_ID_BLOCK_CONFIG } from "../../../../src/lib/parser/id-block/config";
import type { UserLegitimacySignals } from "../../../../src/lib/parser/id-block/types";

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const THR = 0.35;
const THIN = 0.35;

function sig(p: Partial<UserLegitimacySignals> = {}): UserLegitimacySignals {
  return {
    userId: "u",
    hasClaimsWithEob: false,
    hasActiveSubscription: false,
    hasInsuranceCard: false,
    accountAgeDays: 0,
    signupToUploadLatencyDays: 0,
    activityBreadth: 0,
    profileCompleteness: 0,
    ...p,
  };
}
const FAT: Partial<UserLegitimacySignals> = {
  hasClaimsWithEob: true,
  hasActiveSubscription: true,
  hasInsuranceCard: true,
  accountAgeDays: 365,
  signupToUploadLatencyDays: 60,
  activityBreadth: 16,
  profileCompleteness: 1,
};

const cases: { name: string; run: () => boolean }[] = [
  {
    name: "empty cluster → all-zero summary, not uniformly thin",
    run: () => {
      const s = summarizeMemberScores([], THR, THIN);
      return s.min === 0 && s.median === 0 && s.max === 0 && s.pctBelowBar === 0 && !s.uniformlyThin;
    },
  },
  {
    name: "single fat score ≥ bar → 0% below, not thin",
    run: () => {
      const s = summarizeMemberScores([0.5], THR, THIN);
      return s.min === 0.5 && s.median === 0.5 && s.max === 0.5 && s.pctBelowBar === 0 && !s.uniformlyThin;
    },
  },
  {
    name: "single thin score < bar → 100% below, uniformly thin",
    run: () => {
      const s = summarizeMemberScores([0.2], THR, THIN);
      return approx(s.pctBelowBar, 1) && s.uniformlyThin;
    },
  },
  {
    name: "odd set median = middle; one below bar",
    run: () => {
      const s = summarizeMemberScores([0.1, 0.5, 0.9], THR, THIN);
      return s.min === 0.1 && s.max === 0.9 && approx(s.median, 0.5) && approx(s.pctBelowBar, 1 / 3) && !s.uniformlyThin;
    },
  },
  {
    name: "even set median = mean of middles",
    run: () => {
      const s = summarizeMemberScores([0.2, 0.4], THR, THIN);
      return approx(s.median, 0.3) && approx(s.pctBelowBar, 0.5) && !s.uniformlyThin;
    },
  },
  {
    name: "all-thin set → uniformly thin, 100% below",
    run: () => {
      const s = summarizeMemberScores([0.1, 0.2, 0.3], THR, THIN);
      return s.uniformlyThin && approx(s.pctBelowBar, 1);
    },
  },
  {
    name: "boundary: score == bar is NOT below and NOT thin (strict <)",
    run: () => {
      const s = summarizeMemberScores([0.35], THR, THIN);
      return s.pctBelowBar === 0 && !s.uniformlyThin;
    },
  },
  {
    name: "trustTier maps all four verification states",
    run: () =>
      trustTier(true, true) === "phone_email" &&
      trustTier(false, true) === "phone_only" &&
      trustTier(true, false) === "email_only" &&
      trustTier(false, false) === "unverified",
  },
  {
    name: "toBaselineTuple coerces number/null/missing/string to the 4 identity scalars",
    run: () => {
      const t = toBaselineTuple({
        in_deductible_individual: 2000,
        in_deductible_family: null,
        in_oop_max_individual: "5000",
        // in_oop_max_family missing
      });
      return (
        t.in_deductible_individual === 2000 &&
        t.in_deductible_family === null &&
        t.in_oop_max_individual === 5000 &&
        t.in_oop_max_family === null &&
        Object.keys(t).length === 4
      );
    },
  },
  {
    name: "contributions SUM to score (fat user) — §4.1 breakdown is honest",
    run: () => {
      const r = scoreUserLegitimacy(sig(FAT), DEFAULT_ID_BLOCK_CONFIG);
      const sum = Object.values(r.contributions).reduce((a, b) => a + b, 0);
      return approx(sum, r.score);
    },
  },
  {
    name: "contributions SUM to score (thin user)",
    run: () => {
      const r = scoreUserLegitimacy(sig({ hasInsuranceCard: true }), DEFAULT_ID_BLOCK_CONFIG);
      const sum = Object.values(r.contributions).reduce((a, b) => a + b, 0);
      return approx(sum, r.score);
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${err ? `  (threw: ${err})` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
