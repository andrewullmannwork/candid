/**
 * state-lanes — the per-state DFY lane registry (handoff §3; models doc II.2).
 *
 * A TS registry with a CI fixture, like the citation registry: legally-gated
 * data changes via a reviewed PR, never a DB config edit. Every state has a
 * row; only California is open, and only for the insurer lane's free pilot.
 *
 * `dfpiRegistered` is the R15 future-compatibility home: the CA negotiation
 * letter's geo-gate (letter-access.ts) and the paid-lane check read THIS ONE
 * FACT. When Candid's DFPI registration becomes EFFECTIVE, the un-gate runbook
 * (legal review §2 — file ~45 days ahead, wait for effectiveness, THEN this PR)
 * flips it here, and both gates open together with zero rework.
 */

export type LaneStatus = "pilot" | "closed";

export interface StateLane {
  state: string;
  lane: "insurer";
  status: LaneStatus;
  /** The state's debt-settlement / CCFPL-style registration regime reaches the
   *  provider-negotiation instrument (today: California's DFPI). */
  dfpiRegime: boolean;
  /** Candid's registration is EFFECTIVE here. Flipped only by the un-gate
   *  runbook, via a reviewed PR. Registration PENDING is still `false`. */
  dfpiRegistered: boolean;
  authorityNote: string;
  /** YYYY-MM-DD the row was last verified against its sources. */
  verifiedOn: string;
}

const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT",
  "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

const VERIFIED_ON = "2026-09-01";

const CA_LANE: StateLane = {
  state: "CA",
  lane: "insurer",
  status: "pilot",
  dfpiRegime: true,
  dfpiRegistered: false,
  authorityNote:
    "Insurer lane only, free invitation-only pilot (S326 ruling: free pilot first, then $5). " +
    "Gates 0–6 fail-closed at intake; DMHC-level filings are signed and filed by the MEMBER (Gate 4); " +
    "Candid acts as designated representative in the plan's internal appeal and in federal external " +
    "review for self-funded ERISA. Provider-negotiation instrument stays geo-gated until DFPI " +
    "registration is EFFECTIVE (legal review §2 runbook).",
  verifiedOn: VERIFIED_ON,
};

function closedLane(state: string): StateLane {
  return {
    state,
    lane: "insurer",
    status: "closed",
    dfpiRegime: false,
    dfpiRegistered: false,
    authorityNote:
      "DFY lane not opened here — per-state analysis pending (models doc II.2). The free tool is unaffected.",
    verifiedOn: VERIFIED_ON,
  };
}

export const STATE_LANES: Readonly<Record<string, StateLane>> = Object.freeze(
  Object.fromEntries(
    US_STATE_CODES.map((code) => [code, code === "CA" ? CA_LANE : closedLane(code)]),
  ),
);

/** Two-letter code, uppercased and trimmed; null for anything else. */
export function normalizeStateCode(state: string | null | undefined): string | null {
  if (typeof state !== "string") return null;
  const s = state.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

export function laneFor(state: string | null | undefined): StateLane | null {
  const code = normalizeStateCode(state);
  return code ? (STATE_LANES[code] ?? null) : null;
}

/** True only for a state whose insurer lane is open (pilot). Unknown = closed. */
export function dfyLaneOpen(state: string | null | undefined): boolean {
  return laneFor(state)?.status === "pilot";
}

/**
 * The states where the self-pay `negotiation` letter is geo-gated: a
 * registration regime applies and Candid is not (yet) registered. Consumed by
 * letter-access.ts — ONE fact, two gates.
 */
export const NEGOTIATION_GEO_GATED_STATES: readonly string[] = Object.freeze(
  Object.values(STATE_LANES)
    .filter((l) => l.dfpiRegime && !l.dfpiRegistered)
    .map((l) => l.state),
);
