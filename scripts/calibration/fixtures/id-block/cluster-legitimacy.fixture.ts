/**
 * ID-Block cluster-legitimacy fixture (Ship Gate G4 — security-critical pure fn).
 *
 * Locks the §3.2–§3.6 GATE math BEFORE it ever hooks the live CF-40 promotion path:
 *   - per-user legitimacy is weight-scale-independent in [0,1] (exact math),
 *   - a LEGIT shared SBC (high-legitimacy, same-content, even bursty) does NOT flag,
 *   - the REPLAY attack (thin + same-content) flags via sameContentReplay (§3.4),
 *   - a NOVEL canonical + thin cluster flags via novelLowLegitimacy even when the
 *     documents are NOT same-content (§3.6),
 *   - MEDIAN robustness: a minority planted "fat" account doesn't rescue a thin
 *     cluster; a majority does (the economic bound),
 *   - clusters < 2 never flag; thin-but-no-trigger never flags.
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/calibration/fixtures/id-block/cluster-legitimacy.fixture.ts
 *
 * Pass criteria: all cases PASS. Exit 0 on PASS, 1 on any failure.
 */

import {
  scoreClusterLegitimacy,
  scoreUserLegitimacy,
} from "../../../../src/lib/parser/id-block/cluster-legitimacy";
import { computeContentFingerprint } from "../../../../src/lib/parser/id-block/content-fingerprint";
import { DEFAULT_ID_BLOCK_CONFIG } from "../../../../src/lib/parser/id-block/config";
import type {
  ClusterMember,
  UserLegitimacySignals,
} from "../../../../src/lib/parser/id-block/types";

// ── builders ──────────────────────────────────────────────────────────────────
let uid = 0;
function sig(p: Partial<UserLegitimacySignals> = {}): UserLegitimacySignals {
  return {
    userId: `u${uid++}`,
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
function member(
  fp: string | null,
  uploadedAt: string,
  accountCreatedAt: string,
  s: UserLegitimacySignals,
): ClusterMember {
  return { signals: s, contentFingerprint: fp, uploadedAt, accountCreatedAt };
}

// Same vs distinct content fingerprints.
const FP_A = computeContentFingerprint("the overall plan deductible is two thousand dollars per individual");
const FP_B = computeContentFingerprint("dental cleanings twice a year crowns and bridges need prior authorization");
const FP_C = computeContentFingerprint("vision exam once per year frames allowance and contact lens benefit details");

// Bursty + signup-correlated timestamps (attack shape).
const UP = ["2026-06-01T10:00:00Z", "2026-06-01T13:00:00Z", "2026-06-02T09:00:00Z"];
const SU = ["2026-05-30T08:00:00Z", "2026-05-30T20:00:00Z", "2026-05-31T06:00:00Z"];
// Spread-out uploads (organic shape).
const UP_SPREAD = ["2026-01-05T10:00:00Z", "2026-03-12T13:00:00Z", "2026-06-01T09:00:00Z"];
const SU_SPREAD = ["2024-02-01T08:00:00Z", "2025-03-15T20:00:00Z", "2026-01-31T06:00:00Z"];

const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

interface Case {
  name: string;
  run: () => boolean;
  detail?: () => string;
}

const cases: Case[] = [
  // ── per-user math ──
  {
    name: "scoreUserLegitimacy: fully-loaded user → 1.0",
    run: () => approx(scoreUserLegitimacy(sig(FAT)).score, 1.0),
    detail: () => `score=${scoreUserLegitimacy(sig(FAT)).score}`,
  },
  {
    name: "scoreUserLegitimacy: fully-thin user → 0.0",
    run: () => approx(scoreUserLegitimacy(sig()).score, 0),
  },
  {
    name: "scoreUserLegitimacy: only-high-artifacts user → high/Σw = 1/1.7",
    run: () =>
      approx(
        scoreUserLegitimacy(
          sig({ hasClaimsWithEob: true, hasActiveSubscription: true, hasInsuranceCard: true }),
        ).score,
        1.0 / 1.7,
      ),
  },
  {
    name: "scoreUserLegitimacy: contributions sum to score",
    run: () => {
      const r = scoreUserLegitimacy(sig({ ...FAT, profileCompleteness: 0.5, activityBreadth: 4 }));
      const sum = Object.values(r.contributions).reduce((a, b) => a + b, 0);
      return approx(sum, r.score, 1e-9);
    },
  },

  // ── cluster: legit passes ──
  {
    name: "LEGIT shared SBC (high-legitimacy, same-content, bursty) → does NOT flag",
    run: () => {
      const m = [
        member(FP_A, UP[0], SU[0], sig(FAT)),
        member(FP_A, UP[1], SU[1], sig(FAT)),
        member(FP_A, UP[2], SU[2], sig(FAT)),
      ];
      const r = scoreClusterLegitimacy(m, { isNovelCanonical: false });
      return r.sameContent && !r.wouldFlag;
    },
    detail: () => {
      const m = [
        member(FP_A, UP[0], SU[0], sig(FAT)),
        member(FP_A, UP[1], SU[1], sig(FAT)),
        member(FP_A, UP[2], SU[2], sig(FAT)),
      ];
      const r = scoreClusterLegitimacy(m, { isNovelCanonical: false });
      return `sameContent=${r.sameContent} score=${r.clusterScore.toFixed(2)} flag=${r.wouldFlag}`;
    },
  },

  // ── cluster: replay attack ──
  {
    name: "REPLAY attack (3 thin, same-content, bursty, signup-correlated) → flags (sameContentReplay)",
    run: () => {
      const m = [
        member(FP_A, UP[0], SU[0], sig()),
        member(FP_A, UP[1], SU[1], sig()),
        member(FP_A, UP[2], SU[2], sig()),
      ];
      const r = scoreClusterLegitimacy(m, { isNovelCanonical: false });
      return (
        r.wouldFlag &&
        r.sameContentReplay &&
        r.sameContent &&
        r.shape.uniformlyThin &&
        r.shape.temporalBurst &&
        r.shape.signupCorrelated
      );
    },
  },

  // ── cluster: novel-canonical, NOT same-content ──
  {
    name: "NOVEL canonical + thin cluster, DISTINCT docs → flags (novelLowLegitimacy, not sameContent)",
    run: () => {
      const m = [
        member(FP_A, UP_SPREAD[0], SU_SPREAD[0], sig()),
        member(FP_B, UP_SPREAD[1], SU_SPREAD[1], sig()),
        member(FP_C, UP_SPREAD[2], SU_SPREAD[2], sig()),
      ];
      const r = scoreClusterLegitimacy(m, { isNovelCanonical: true });
      return r.wouldFlag && r.novelLowLegitimacy && !r.sameContent && !r.sameContentReplay;
    },
  },

  // ── median robustness ──
  {
    name: "MEDIAN: minority planted fat account [thin,thin,fat] same-content → still flags",
    run: () => {
      const m = [
        member(FP_A, UP[0], SU[0], sig()),
        member(FP_A, UP[1], SU[1], sig()),
        member(FP_A, UP[2], SU[2], sig(FAT)),
      ];
      const r = scoreClusterLegitimacy(m, { isNovelCanonical: false });
      return r.wouldFlag && r.sameContentReplay;
    },
    detail: () => {
      const m = [
        member(FP_A, UP[0], SU[0], sig()),
        member(FP_A, UP[1], SU[1], sig()),
        member(FP_A, UP[2], SU[2], sig(FAT)),
      ];
      return `median=${scoreClusterLegitimacy(m, { isNovelCanonical: false }).clusterScore.toFixed(2)}`;
    },
  },
  {
    name: "MEDIAN: majority fat [thin,fat,fat] same-content → does NOT flag (economic bound)",
    run: () => {
      const m = [
        member(FP_A, UP[0], SU[0], sig()),
        member(FP_A, UP[1], SU[1], sig(FAT)),
        member(FP_A, UP[2], SU[2], sig(FAT)),
      ];
      const r = scoreClusterLegitimacy(m, { isNovelCanonical: false });
      return !r.wouldFlag;
    },
  },

  // ── guards ──
  {
    name: "cluster < 2 members → never flags",
    run: () => {
      const m = [member(FP_A, UP[0], SU[0], sig())];
      const r = scoreClusterLegitimacy(m, { isNovelCanonical: true });
      return !r.wouldFlag;
    },
  },
  {
    name: "thin cluster, all-null fingerprints, NON-novel → no trigger → no flag",
    run: () => {
      const m = [
        member(null, UP[0], SU[0], sig()),
        member(null, UP[1], SU[1], sig()),
        member(null, UP[2], SU[2], sig()),
      ];
      const r = scoreClusterLegitimacy(m, { isNovelCanonical: false });
      return !r.wouldFlag && !r.sameContent;
    },
  },
  {
    name: "config defaults: mode shadow, threshold 0.35, hamming 3",
    run: () =>
      DEFAULT_ID_BLOCK_CONFIG.gate.mode === "shadow" &&
      approx(DEFAULT_ID_BLOCK_CONFIG.gate.clusterLegitimacyThreshold, 0.35) &&
      DEFAULT_ID_BLOCK_CONFIG.gate.hammingNearDupThreshold === 3,
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
