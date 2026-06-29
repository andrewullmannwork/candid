// Obligation registry — consumer side (R3 step 3).
//
// The catalog (dispute-ground-catalog.ts) owns the obligation STRUCTURE + the voice DECISION
// (selectObligationVoice). This file owns the two consumer-side pieces:
//   1. buildObligationContext — the DATA seam (line signals → predicate context).
//   2. OBLIGATION_PROSE + renderObligationClauses — the versioned COPY + the clause strings a
//      letter ask composes.
// Wired into the LIVE letter at buildRequestSection (templates.ts), gated by dispute_grounds_v1
// (demandsEnabled). Byte-identical today: every predicate is unknown → the safe voice
// (fall_to_facts / omit) → today's clause.

import type { DisputeGroundType } from "./dispute-grounds";
import {
  DISPUTE_GROUND_CATALOG,
  selectObligationVoice,
  type ObligationContext,
  type ObligationParty,
  type ObligationVoice,
} from "./dispute-ground-catalog";

/**
 * Build the predicate context an ask's obligation voices are evaluated against. Returns ALL-NULL
 * today — no NSA / contract / statute / rate signal exists on LineItemEvidence yet, so every
 * predicate is unknown and the registry defaults to the safe voice (byte-identical). This function
 * is the ONE seam the post-launch Care data layer ([[care_network_rate_transparency]] §3.2.1)
 * plugs into: it will take the ask's lines and aggregate per-line signals
 * (e.g. `nsaApplicable: lines.some(...)`); the single caller passes them when that data lands.
 * Kept as a function (not a constant) precisely to mark that seam.
 */
export function buildObligationContext(): ObligationContext {
  return {
    nsaApplicable: null,
    contractExists: null,
    statuteVerified: null,
    rateKnown: null,
  };
}

/**
 * Versioned obligation PROSE, keyed by element × voice. `fall_to_facts` reproduces today's
 * facts-based clause VERBATIM (byte-identical); `demand` / `raise` are the upgraded asks, INERT
 * today (selected only when a predicate is met AND demands are enabled). `omit` needs no entry
 * (renders nothing). The demand copy is INTERIM — incr-5 replaces it with the counsel-reviewed
 * §19 paragraphs (NSA safe-harbor + CMS escalation; contracted-rate apply).
 */
const OBLIGATION_PROSE: Record<string, Partial<Record<ObligationVoice, string>>> = {
  nsa_protection: {
    fall_to_facts: "apply any applicable No Surprises Act protections",
    // INTERIM — incr-5: + conditional applicability + 30-day safe-harbor offer + CMS escalation.
    demand:
      "apply the No Surprises Act's balance-billing protections, which limit my responsibility for these services to my in-network cost-sharing",
  },
  contracted_rate_apply: {
    // voiceIfNot = omit (no clause today). INTERIM demand — incr-5 + Care contracted-rate data (§18.10.B).
    demand: "process these services at the contracted in-network rate and restate my balance accordingly",
  },
};

/**
 * Render a ground's obligation clauses for ONE recipient: filter the catalog's elements to that
 * party, pick each element's voice (default-safe via selectObligationVoice), drop `omit`, map the
 * rest through OBLIGATION_PROSE. Returns bare clause fragments (no leading conjunction) for the
 * caller to compose. Elements with no prose entry yet (not wired in step 3) yield nothing.
 */
export function renderObligationClauses(
  ground: DisputeGroundType,
  recipient: ObligationParty,
  ctx: ObligationContext,
  demandsEnabled: boolean,
): string[] {
  const clauses: string[] = [];
  for (const el of DISPUTE_GROUND_CATALOG[ground].obligationElements) {
    if (el.party !== recipient) continue;
    const voice = selectObligationVoice(el, ctx, demandsEnabled);
    if (voice === "omit") continue;
    const prose = OBLIGATION_PROSE[el.element]?.[voice];
    if (prose) clauses.push(prose);
  }
  return clauses;
}
