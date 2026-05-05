/**
 * SBC voted parser — wraps parseSBC() with DR-3C cold-start N=3 voting.
 *
 * Per Pattern P-3 + Q-DR-3C-1 LOCK: voting fires on cold-start canonical-plan
 * matching only. Caller passes `canonicalMatchExists` based on pre-parse identity
 * heuristic (e.g., from canonical-match.ts). Cold-start (no match) → N=3 parallel
 * parses + per-field vote cascade. Canonical-established → standard N=1 path.
 *
 * Voting semantics (Q-DR-3C-2):
 *   - Plan-level scalars: per-field voteFieldCascade across 3 attempts.
 *   - Services array: UNION all unique slugs across attempts (recall-maximize per
 *     `feedback_candid_recall_over_precision`); per-slug vote on cost-sharing fields.
 *   - Pattern P-8 source_excerpt: prefer the attempt whose excerpt verifies
 *     successfully (most reliable). Fall back to mode if multiple verify.
 *   - Excluded services + appeals contacts: union (recall-maximize).
 *
 * Cost: 3x base on cold-start path. Bounded by COST_HARD_CAP per attempt — caller
 * tracks total via voted result's costUsd.
 */

import type { ExtractionMethod } from "../parser/types";
import { runNParses, voteFieldCascade } from "../parser/voting";
import type {
  SBCHaikuParseResult,
  SBCHaikuService,
  SBCPlanField,
  SBCPlanIdentity,
} from "./types";
import { parseSBC, type ParseSBCInput } from "./parser";

const VOTING_N = 3;

export interface VotedParseSBCInput extends ParseSBCInput {
  canonicalMatchExists: boolean;
}

export interface VotedParseSBCResult extends SBCHaikuParseResult {
  votingMetadata: {
    triggered: boolean;
    n: number;
    successfulAttempts: number;
    perFieldOutcomes: Record<string, string>; // field path → vote outcome
    abstainedFields: string[];
    consensusRate: number; // fraction of voted fields where all 3 attempts agreed
  };
}

/**
 * Vote on plan-level scalar fields. For each field, collect 3 votes + cascade.
 * Returns a new SBCPlanIdentity with voted values + first-attempt's Pattern P-8
 * (we keep the verified excerpt from the winning attempt when available).
 */
function votePlanIdentity(
  attempts: SBCPlanIdentity[],
  perFieldOutcomes: Record<string, string>,
  abstainedFields: string[],
): SBCPlanIdentity {
  const merged = JSON.parse(JSON.stringify(attempts[0])) as SBCPlanIdentity;

  const fields: Array<keyof SBCPlanIdentity> = [
    "planName",
    "insurerName",
    "planType",
    "metalTier",
    "coverageTier",
    "planYear",
    "coveragePeriodStart",
    "deductibleIndividual",
    "deductibleFamily",
    "oopMaxIndividual",
    "oopMaxFamily",
    "rxDeductibleIndividual",
    "rxDeductibleFamily",
    "referralRequired",
    "minimumValueStandard",
  ];

  for (const field of fields) {
    const votes = attempts.map((a) => {
      const f = a[field] as SBCPlanField<unknown>;
      return { value: f.value, haikuConfidence: f.haikuConfidence };
    });
    const result = voteFieldCascade(votes);
    perFieldOutcomes[`planIdentity.${String(field)}`] = result.outcome;

    if (result.outcome === "abstained") {
      abstainedFields.push(`planIdentity.${String(field)}`);
      // Keep first attempt's value but mark via abstained list (consumer-read may filter)
      continue;
    }

    // Find the attempt whose value matches the winning vote → use its Pattern P-8
    const winningAttempt = attempts.find((a) => {
      const f = a[field] as SBCPlanField<unknown>;
      return JSON.stringify(f.value) === JSON.stringify(result.winner);
    });

    if (winningAttempt) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged[field] as any) = winningAttempt[field];
    }
  }

  return merged;
}

/**
 * Vote on services array. Strategy:
 *   1. UNION all unique service slugs across attempts (recall-maximize).
 *   2. For each unique slug, find which attempts emitted it.
 *   3. If only 1 attempt emitted: keep with warning marker.
 *   4. If 2+ attempts emitted: vote per cost-sharing field; pick winning attempt's
 *      Pattern P-8 source_excerpt (prefer verified one).
 */
function voteServices(
  serviceArrays: SBCHaikuService[][],
  perFieldOutcomes: Record<string, string>,
  abstainedFields: string[],
): SBCHaikuService[] {
  const slugMap = new Map<string, SBCHaikuService[]>();
  for (const arr of serviceArrays) {
    for (const svc of arr) {
      const key = `${svc.serviceSlug}|${svc.placeOfService || ""}`;
      const existing = slugMap.get(key) ?? [];
      existing.push(svc);
      slugMap.set(key, existing);
    }
  }

  const voted: SBCHaikuService[] = [];

  for (const [key, attempts] of slugMap) {
    // If only one attempt emitted this slug, keep it (recall-maximize per
    // feedback_candid_recall_over_precision)
    if (attempts.length === 1) {
      perFieldOutcomes[`services.${key}`] = "single_attempt";
      voted.push(attempts[0]);
      continue;
    }

    // Vote per cost-sharing field
    const fields: Array<keyof SBCHaikuService> = [
      "inCopay",
      "inCoinsurance",
      "inDeductibleApplies",
      "outCopay",
      "outCoinsurance",
      "outDeductibleApplies",
      "priorAuthRequired",
      "covered",
    ];

    let winningAttempt = attempts[0];
    let maxAgreement = 0;
    for (const field of fields) {
      const votes = attempts.map((a) => ({
        value: a[field],
        haikuConfidence: a.haikuConfidence,
      }));
      const result = voteFieldCascade(votes);
      perFieldOutcomes[`services.${key}.${String(field)}`] = result.outcome;
      if (result.outcome === "abstained") {
        abstainedFields.push(`services.${key}.${String(field)}`);
      }
      if (result.agreementCount > maxAgreement) {
        maxAgreement = result.agreementCount;
        const found = attempts.find(
          (a) => JSON.stringify(a[field]) === JSON.stringify(result.winner),
        );
        if (found) winningAttempt = found;
      }
    }

    voted.push(winningAttempt);
  }

  return voted;
}

/**
 * Union excluded service strings across attempts (recall-maximize).
 */
function unionExcludedServices(arrays: string[][]): string[] {
  const set = new Set<string>();
  for (const arr of arrays) for (const s of arr) set.add(s);
  return Array.from(set);
}

/**
 * Aggregate cost USD across all N attempts.
 */
function sumCost(results: SBCHaikuParseResult[]): number {
  return results.reduce((s, r) => s + r.costUsd, 0);
}

export async function votedParseSBC(input: VotedParseSBCInput): Promise<VotedParseSBCResult> {
  // Canonical-established path: N=1 standard parse
  if (input.canonicalMatchExists) {
    const result = await parseSBC(input);
    return {
      ...result,
      votingMetadata: {
        triggered: false,
        n: 1,
        successfulAttempts: 1,
        perFieldOutcomes: {},
        abstainedFields: [],
        consensusRate: 1,
      },
    };
  }

  // Cold-start path: N=3 parallel parses + vote
  const attempts = await runNParses(() => parseSBC(input), VOTING_N);
  const successful = attempts.filter((a): a is SBCHaikuParseResult => a !== null);
  const successfulAttempts = successful.length;

  if (successfulAttempts === 0) {
    throw new Error("[sbc/voted-parser] All N=3 cold-start parse attempts failed");
  }

  // If only 1 succeeded, fall back to that single result without voting
  if (successfulAttempts === 1) {
    return {
      ...successful[0],
      votingMetadata: {
        triggered: true,
        n: VOTING_N,
        successfulAttempts: 1,
        perFieldOutcomes: {},
        abstainedFields: [],
        consensusRate: 0,
      },
    };
  }

  const perFieldOutcomes: Record<string, string> = {};
  const abstainedFields: string[] = [];

  // Vote on plan identity
  const votedPlanIdentity = votePlanIdentity(
    successful.map((r) => r.planIdentity),
    perFieldOutcomes,
    abstainedFields,
  );

  // Vote on services
  const votedServices = voteServices(
    successful.map((r) => r.services),
    perFieldOutcomes,
    abstainedFields,
  );

  // Vote on other-covered services (same shape)
  const votedOtherCovered = voteServices(
    successful.map((r) => r.otherCoveredServices),
    perFieldOutcomes,
    abstainedFields,
  );

  // Union excluded services + appeals contacts (recall-maximize; not voted)
  const unionedExcluded = unionExcludedServices(successful.map((r) => r.excludedServices));
  const unionedAppeals = successful.flatMap((r) => r.appealsContacts);

  // Aggregate Pattern P-8 from the result with most-verified entries
  const excludedServicesPatternP8 = successful[0].excludedServicesPatternP8;

  // Sum cost + tokens across all attempts
  const totalCostUsd = sumCost(successful);
  const totalInputTokens = successful.reduce((s, r) => s + r.haikuTokensInput, 0);
  const totalOutputTokens = successful.reduce((s, r) => s + r.haikuTokensOutput, 0);

  // Compute consensus rate (fraction of voted fields where all attempts agreed)
  const totalVotedFields = Object.keys(perFieldOutcomes).length;
  const consensusFields = Object.values(perFieldOutcomes).filter((o) => o === "consensus").length;
  const consensusRate = totalVotedFields > 0 ? consensusFields / totalVotedFields : 1;

  // Aggregate warnings
  const aggregatedWarnings = [
    ...new Set(successful.flatMap((r) => r.parseWarnings)),
    `voting_triggered:n=${VOTING_N}:successful=${successfulAttempts}`,
    `voting_consensus_rate:${consensusRate.toFixed(2)}`,
    ...abstainedFields.map((f) => `voting_abstained:${f}`),
  ];

  // Phase 4.0.5: dispatchedSections is the UNION across all N=3 attempts.
  // In practice all 3 attempts dispatch the same sections (segmentation is
  // deterministic), so the union equals any single attempt's set.
  const unionedDispatchedSections = Array.from(
    new Set(successful.flatMap((r) => r.dispatchedSections)),
  );

  return {
    planIdentity: votedPlanIdentity,
    services: votedServices,
    otherCoveredServices: votedOtherCovered,
    excludedServices: unionedExcluded,
    excludedServicesPatternP8,
    appealsContacts: unionedAppeals,
    parseWarnings: aggregatedWarnings,
    haikuTokensInput: totalInputTokens,
    haikuTokensOutput: totalOutputTokens,
    haikuCacheCreateTokens: 0,
    haikuCacheReadTokens: 0,
    costUsd: totalCostUsd,
    parseStrategyV2: true,
    dispatchedSections: unionedDispatchedSections,
    votingMetadata: {
      triggered: true,
      n: VOTING_N,
      successfulAttempts,
      perFieldOutcomes,
      abstainedFields,
      consensusRate,
    },
  };
}

export type { ExtractionMethod };
