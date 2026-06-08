/**
 * ID-Block — cluster-legitimacy scorer (the §3.2/§3.3 GATE math).
 *
 * Pure, no IO. Two functions:
 *   - scoreUserLegitimacy: per-corroborating-user legitimacy in [0,1] from the §9.1
 *     signals, weighted by cost-to-fake (costly artifacts dominate).
 *   - scoreClusterLegitimacy: judges the cluster SHAPE — the MEDIAN per-user score
 *     (robust: one planted aged/paid account can't lift a thin cluster past the bar
 *     unless a MAJORITY are real) plus the attack-signature flags (uniformly thin /
 *     temporal burst / signup-time correlation) — and evaluates the TWO independent
 *     flag triggers: same-document replay (§3.4) and novel-canonical low-legitimacy
 *     (§3.6).
 *
 * The threshold comparison lives here (pure → fixture-locked, Ship Gate G4). The
 * quarantine ACTION (hold vs shadow-log) + Slack live in the PR2 IO hook; this module
 * only decides `wouldFlag`.
 *
 * Fixture: scripts/calibration/fixtures/id-block/cluster-legitimacy.fixture.ts
 * SoT: plans/id-block-corroboration-source-independence.md §3.2–§3.6 + §9.1.
 */

import { DEFAULT_ID_BLOCK_CONFIG, type IdBlockConfig } from "./config";
import { hammingDistance } from "./content-fingerprint";
import type {
  ClusterContext,
  ClusterLegitimacyResult,
  ClusterMember,
  ClusterShapeResult,
  UserLegitimacyResult,
  UserLegitimacySignals,
} from "./types";

/** clamp to [0,1]. */
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** saturating normalization x/cap → [0,1]; a non-positive cap disables the signal (0). */
const norm = (x: number, cap: number): number => (cap > 0 ? clamp01(x / cap) : 0);

/**
 * Per-user legitimacy in [0,1]. score = Σ(weight·band) / Σweight, so the result is
 * weight-scale-independent and always in [0,1]. `contributions` breaks the score down
 * per signal for the §4.1 admin view (they sum to `score`).
 */
export function scoreUserLegitimacy(
  s: UserLegitimacySignals,
  cfg: IdBlockConfig = DEFAULT_ID_BLOCK_CONFIG,
): UserLegitimacyResult {
  const { weights, normCaps } = cfg;

  // Band sub-scores, each in [0,1].
  const eob = s.hasClaimsWithEob ? 1 : 0;
  const sub = s.hasActiveSubscription ? 1 : 0;
  const card = s.hasInsuranceCard ? 1 : 0;
  const high = (eob + sub + card) / 3;

  const ageN = norm(s.accountAgeDays, normCaps.accountAgeDaysCap);
  const latN = norm(s.signupToUploadLatencyDays, normCaps.signupLatencyDaysCap);
  const brN = norm(s.activityBreadth, normCaps.activityBreadthCap);
  const medium = (ageN + latN + brN) / 3;

  const low = clamp01(s.profileCompleteness);

  const wSum = weights.high + weights.medium + weights.low;
  const safeSum = wSum > 0 ? wSum : 1;
  const score = (weights.high * high + weights.medium * medium + weights.low * low) / safeSum;

  // Per-signal contributions (sum to `score`): each signal's share of its band, times
  // the band's weight share.
  const contributions: Record<string, number> = {
    claims_with_eob: (weights.high * (eob / 3)) / safeSum,
    active_subscription: (weights.high * (sub / 3)) / safeSum,
    insurance_card: (weights.high * (card / 3)) / safeSum,
    account_age: (weights.medium * (ageN / 3)) / safeSum,
    signup_latency: (weights.medium * (latN / 3)) / safeSum,
    activity_breadth: (weights.medium * (brN / 3)) / safeSum,
    profile_completeness: (weights.low * low) / safeSum,
  };

  return { score, bands: { high, medium, low }, contributions };
}

/** Median of a numeric list ([] → 0). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Max span (hours) between the min and max of a list of ISO timestamps. */
function spanHours(isoTimes: string[]): number {
  const ts = isoTimes.map((t) => new Date(t).getTime()).filter((n) => Number.isFinite(n));
  if (ts.length < 2) return 0;
  return (Math.max(...ts) - Math.min(...ts)) / 3_600_000;
}

/**
 * Size of the largest near-duplicate group among the members' fingerprints. O(N²)
 * over a small cluster. A member with a null/malformed fingerprint never joins a
 * group (hammingDistance returns 64 for such input).
 */
function largestNearDupGroup(fingerprints: (string | null)[], hammingThreshold: number): number {
  const fps = fingerprints.filter((f): f is string => !!f);
  if (fps.length === 0) return 0;
  let best = 1;
  for (let i = 0; i < fps.length; i++) {
    let count = 1;
    for (let j = 0; j < fps.length; j++) {
      if (i !== j && hammingDistance(fps[i], fps[j]) <= hammingThreshold) count++;
    }
    if (count > best) best = count;
  }
  return best;
}

/**
 * Cluster-legitimacy gate. Returns wouldFlag = (same-content replay) OR
 * (novel-canonical low-legitimacy). A cluster too small to corroborate (< 2 members)
 * never flags.
 */
export function scoreClusterLegitimacy(
  members: ClusterMember[],
  context: ClusterContext,
  cfg: IdBlockConfig = DEFAULT_ID_BLOCK_CONFIG,
): ClusterLegitimacyResult {
  const { shape: shapeCfg, gate } = cfg;
  const scores = members.map((m) => scoreUserLegitimacy(m.signals, cfg).score);
  const clusterScore = median(scores);

  const shape: ClusterShapeResult = {
    medianScore: clusterScore,
    uniformlyThin: members.length > 0 && scores.every((sc) => sc < shapeCfg.thinScore),
    temporalBurst:
      members.length >= 2 &&
      spanHours(members.map((m) => m.uploadedAt)) <= shapeCfg.burstWindowHours,
    signupCorrelated:
      members.length >= 2 &&
      spanHours(members.map((m) => m.accountCreatedAt)) <= shapeCfg.signupCorrelationWindowHours,
  };

  // Same-content: the largest near-dup group is ≥ a majority of fingerprinted members
  // (and ≥ 2). "These corroborators are the same document."
  const fingerprints = members.map((m) => m.contentFingerprint);
  const fpCount = fingerprints.filter(Boolean).length;
  const nearDup = largestNearDupGroup(fingerprints, gate.hammingNearDupThreshold);
  const sameContent =
    fpCount >= 2 && nearDup >= 2 && nearDup >= Math.ceil(fpCount * gate.sameContentMajority);

  const belowBar = members.length >= 2 && clusterScore < gate.clusterLegitimacyThreshold;
  const sameContentReplay = sameContent && belowBar;
  const novelLowLegitimacy = context.isNovelCanonical && belowBar;
  const wouldFlag = sameContentReplay || novelLowLegitimacy;

  const reasons: string[] = [];
  if (sameContentReplay) {
    reasons.push(
      `same-document replay: ${nearDup}/${fpCount} corroborators are near-duplicate (Hamming ≤ ${gate.hammingNearDupThreshold}) and cluster legitimacy ${clusterScore.toFixed(2)} < ${gate.clusterLegitimacyThreshold}`,
    );
  }
  if (novelLowLegitimacy) {
    reasons.push(
      `novel canonical with low-legitimacy cluster: legitimacy ${clusterScore.toFixed(2)} < ${gate.clusterLegitimacyThreshold}, no authoritative seed to outvote`,
    );
  }
  if (wouldFlag) {
    if (shape.uniformlyThin) reasons.push("cluster is uniformly thin");
    if (shape.temporalBurst) reasons.push("uploads are temporally bursty");
    if (shape.signupCorrelated) reasons.push("member accounts were created within a narrow window");
  }

  return {
    clusterScore,
    shape,
    sameContent,
    novelCanonical: context.isNovelCanonical,
    sameContentReplay,
    novelLowLegitimacy,
    wouldFlag,
    reasons,
  };
}
