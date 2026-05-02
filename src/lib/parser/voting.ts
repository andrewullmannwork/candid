/**
 * DR-3C 3-parse voting framework per Pattern P-3 + Q-DR-3C-1/2/3 LOCKs.
 *
 * Voting fires on COLD-START only (no canonical-plan match pre-parse). Canonical-
 * established uses N=1 with Pattern 1 #3 corroboration handling drift. Per
 * Pattern P-C "blast-radius asymmetry rationale": cold-start = high blast radius
 * (wrong canonical seed corrupts ALL future users on that plan) → 3x cost justifiable;
 * canonical-established = low blast radius → 1x cost.
 *
 * Tiebreaker cascade per Q-DR-3C-2:
 *   1. mode (most common value across attempts)
 *   2. haiku_confidence (highest self-reported wins on tie)
 *   3. abstain (write null + flag for review + log warning)
 *
 * `no_extraction` outcome separate from `abstained` per Q-DR-3C-2:
 * all-null case handled BEFORE voting cascade → distinguishes parser/prompt
 * issue from value-disagreement.
 *
 * Median tiebreaker REJECTED for numeric fields per Q-DR-3C-2 (median 35 of
 * {30,35,40} is fabricated — not in any parse). Mode + cascade preferred.
 */

export type VoteOutcome = "mode" | "haiku_confidence_breaker" | "consensus" | "abstained" | "no_extraction";

export interface FieldVote<T> {
  value: T | null;
  haikuConfidence?: number;
}

export interface VoteResult<T> {
  winner: T | null;
  outcome: VoteOutcome;
  attemptCount: number;
  agreementCount: number; // how many attempts produced the winning value
}

/**
 * Vote on a single field value across N attempts. Implements the Q-DR-3C-2 cascade:
 *
 *   1. If all attempts emit null → no_extraction outcome.
 *   2. Find the most common non-null value (mode).
 *      - If unique mode (single most-common value): consensus or mode outcome.
 *      - Mode outcome: ≥2 of N agree.
 *      - Consensus outcome: ALL N agree.
 *   3. If tie at mode (multiple values with same count): pick attempt with highest
 *      haiku_confidence. → haiku_confidence_breaker outcome.
 *   4. If still tied (no haiku_confidence available): abstain (return null + warn).
 */
export function voteFieldCascade<T>(votes: FieldVote<T>[]): VoteResult<T> {
  const attemptCount = votes.length;
  const nonNullVotes = votes.filter((v) => v.value !== null && v.value !== undefined);

  if (nonNullVotes.length === 0) {
    return {
      winner: null,
      outcome: "no_extraction",
      attemptCount,
      agreementCount: 0,
    };
  }

  // Tally values by JSON-serialized representation (handles primitives, objects, arrays).
  const tallyMap = new Map<string, { value: T; count: number; maxConfidence: number }>();
  for (const vote of nonNullVotes) {
    const key = JSON.stringify(vote.value);
    const existing = tallyMap.get(key);
    if (existing) {
      existing.count += 1;
      if (typeof vote.haikuConfidence === "number" && vote.haikuConfidence > existing.maxConfidence) {
        existing.maxConfidence = vote.haikuConfidence;
      }
    } else {
      tallyMap.set(key, {
        value: vote.value as T,
        count: 1,
        maxConfidence: typeof vote.haikuConfidence === "number" ? vote.haikuConfidence : 0,
      });
    }
  }

  const tallied = Array.from(tallyMap.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.maxConfidence - a.maxConfidence;
  });

  const top = tallied[0];

  // Single agreement (all 3 attempts had different values, none null) — abstain.
  if (top.count === 1 && nonNullVotes.length === attemptCount) {
    return {
      winner: null,
      outcome: "abstained",
      attemptCount,
      agreementCount: 1,
    };
  }

  // Check for tie at top
  const tiedAtTop = tallied.filter((t) => t.count === top.count);
  if (tiedAtTop.length > 1) {
    // Tiebreaker: highest haiku_confidence
    const breaker = tiedAtTop.sort((a, b) => b.maxConfidence - a.maxConfidence)[0];
    if (breaker.maxConfidence > 0) {
      return {
        winner: breaker.value,
        outcome: "haiku_confidence_breaker",
        attemptCount,
        agreementCount: breaker.count,
      };
    }
    // No haiku_confidence to break the tie → abstain
    return {
      winner: null,
      outcome: "abstained",
      attemptCount,
      agreementCount: top.count,
    };
  }

  // Unique mode
  return {
    winner: top.value,
    outcome: top.count === attemptCount ? "consensus" : "mode",
    attemptCount,
    agreementCount: top.count,
  };
}

/**
 * Run a parse function N times in PARALLEL. Caller is responsible for cost-cap
 * decisions before invoking (this function does NOT pre-check cost).
 *
 * Catches per-attempt errors and returns nulls for failed attempts. Caller decides
 * how to handle (log warning, fall back to single-attempt, etc.).
 */
export async function runNParses<T>(parseFn: () => Promise<T>, n: number): Promise<Array<T | null>> {
  const promises = Array.from({ length: n }, () =>
    parseFn().catch((err) => {
      console.warn(`[voting] parse attempt failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }),
  );
  return Promise.all(promises);
}
