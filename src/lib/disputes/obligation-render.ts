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
import type { LineItemEvidence } from "./evidence-resolver";
import {
  DISPUTE_GROUND_CATALOG,
  selectObligationVoice,
  type ObligationContext,
  type ObligationParty,
  type ObligationVoice,
} from "./dispute-ground-catalog";

/**
 * Build the predicate context an ask's obligation voices are evaluated against, from the ask's
 * lines. R3 step 5.4 Phase 3 (Item B) lit the contracted-rate half of this seam: a balance-billed
 * line carrying a known allowed amount BELOW the billed charge proves a rate is known (`rateKnown`),
 * and when that line is in-network / tiered it proves a participating contract (`contractExists` →
 * the contracted-rate demand). Out-of-network / unknown lines set `rateKnown` but NOT
 * `contractExists` (no proven contract → the letter makes a factual request, not a contract demand;
 * see templates.ts). `nsaApplicable` / `statuteVerified` stay null — they await the post-launch Care
 * rate layer ([[care_network_rate_transparency]] §3.2.1) + the verified citation registry (§4).
 * Booleans are TRUE-or-null (never `false`): absence of proof is "unknown", not "known false", so
 * the selector still defaults to the safe voice. Empty lines / no signal → all-null → byte-identical.
 */
export function buildObligationContext(lines: readonly LineItemEvidence[]): ObligationContext {
  const rateGap = (li: LineItemEvidence): boolean =>
    li.allowedAmount != null && li.billedAmount > li.allowedAmount;
  const rateKnown = lines.some(rateGap);
  const contractExists = lines.some(
    (li) => rateGap(li) && (li.networkStatus === "in_network" || li.networkStatus === "tiered"),
  );
  // Item C — the provider billed above its OWN published standard/average charge: a chargemaster
  // detector finding carries that published rate in `benchmarkAmount`. Null until the detector + the
  // pricing_data hospital_hpt seed land → publishedRateExceeded stays null → the voice omits → inert.
  const publishedRateExceeded = lines.some((li) =>
    (li.auditFindings ?? []).some(
      (f) => f.type === "chargemaster" && f.benchmarkAmount != null && li.billedAmount > f.benchmarkAmount,
    ),
  );
  return {
    nsaApplicable: null,
    contractExists: contractExists ? true : null,
    statuteVerified: null,
    rateKnown: rateKnown ? true : null,
    publishedRateExceeded: publishedRateExceeded ? true : null,
  };
}

/**
 * Versioned obligation PROSE, keyed by element × voice. `fall_to_facts` reproduces today's
 * facts-based clause VERBATIM (byte-identical); `demand` / `raise` are the upgraded asks, INERT
 * today (selected only when a predicate is met AND demands are enabled). `omit` needs no entry
 * (renders nothing). The demand copy is INTERIM — incr-5 replaces it with the counsel-reviewed
 * §19 paragraphs (NSA safe-harbor + CMS escalation).
 */
const OBLIGATION_PROSE: Record<string, Partial<Record<ObligationVoice, string>>> = {
  nsa_protection: {
    fall_to_facts: "apply any applicable No Surprises Act protections",
    // INTERIM — incr-5: + conditional applicability + 30-day safe-harbor offer + CMS escalation.
    demand:
      "apply the No Surprises Act's balance-billing protections, which limit my responsibility for these services to my in-network cost-sharing",
  },
  // R3 step 5.4 Phase 3 (Item B) — `contracted_rate_apply` has NO prose entry on purpose: the
  // contracted-rate copy is DATA-AWARE (cites the per-line $ allowed / billed), rendered directly in
  // templates.ts buildRequestSection, not as a static (element, voice) string. The catalog element
  // still records the obligation (party / authority / predicate); its VOICE gates the data-aware ask.
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
