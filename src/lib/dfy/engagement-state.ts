/**
 * engagement-state — the DFY engagement lifecycle, PURE (the Pattern-O
 * precedent: enumerated states, explicit transitions, additive).
 *
 *   eligibility_pending → signed     the member executed the paper stack
 *   eligibility_pending → terminated declined at intake / withdrew
 *   signed              → active     fee step done (or sponsor code) — execution may begin
 *   signed              → terminated withdrew before activation
 *   active              → converted  a conversion trigger fired (new rationale,
 *                                    "what should I argue?", an un-addressed
 *                                    ground) — back to the member + the free tool
 *   active              → terminated the member or Candid ended it
 *   active              → completed  a determination was recorded and relayed
 *
 * Terminal states never transition. The route layer calls `assertTransition`
 * BEFORE any write; the DB CHECK pins the vocabulary, this module pins the
 * edges.
 */

export const ENGAGEMENT_STATUSES = [
  "eligibility_pending",
  "signed",
  "active",
  "converted",
  "terminated",
  "completed",
] as const;

export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

const TRANSITIONS: Readonly<Record<EngagementStatus, readonly EngagementStatus[]>> = {
  eligibility_pending: ["signed", "terminated"],
  signed: ["active", "terminated"],
  active: ["converted", "terminated", "completed"],
  converted: [],
  terminated: [],
  completed: [],
};

export const TERMINAL_STATUSES: ReadonlySet<EngagementStatus> = new Set([
  "converted",
  "terminated",
  "completed",
]);

/** Statuses under which an operator may ACT on the matter. Exactly one. */
export const ACTIONABLE_STATUSES: readonly EngagementStatus[] = ["active"];

/** Statuses that count against the per-operator concurrent cap. */
export const CAP_COUNTED_STATUSES: readonly EngagementStatus[] = ["signed", "active"];

export function isEngagementStatus(value: unknown): value is EngagementStatus {
  return typeof value === "string" && (ENGAGEMENT_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: EngagementStatus, to: EngagementStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class EngagementTransitionError extends Error {
  readonly from: EngagementStatus;
  readonly to: EngagementStatus;
  constructor(from: EngagementStatus, to: EngagementStatus) {
    super(`dfy engagement: ${from} → ${to} is not an allowed transition`);
    this.name = "EngagementTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: EngagementStatus, to: EngagementStatus): void {
  if (!canTransition(from, to)) throw new EngagementTransitionError(from, to);
}
