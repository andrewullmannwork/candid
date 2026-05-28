/**
 * Map raw artifact keys to canonical field names per parser_site.
 *
 * S138 PR2 extension: per-site axis added.
 *
 * Plan-identity (pre-PR2 behavior preserved):
 *   - Live PROD plan-identity.ts uses camelCase
 *   - Opus + Haiku-comprehensive artifacts use snake_case
 *   - This map normalizes to camelCase canonical
 *
 * New sites (sbc / plan_doc / code_identity / description_match / eoc):
 *   - Calibration runners produce camelCase JSON directly; no snake-to-camel mapping needed
 *   - Lookup just checks if the key is in the site's canonical_fields list
 *   - Unknown keys go to drift_keys (captured for diagnostic)
 *
 * Drift keys (e.g., `deductibleOutOfNetworkIndividual`) are NOT mapped — they're
 * captured separately as drift signals.
 */

import { PARSER_SITE_REGISTRY } from './types';
import type { CanonicalField, ParserSite } from './types';

// Plan-identity snake_case → camelCase canonical (preserved from pre-PR2).
export const PLAN_IDENTITY_SNAKE_TO_CAMEL: Record<string, string> = {
  plan_name: 'planName',
  insurer_name: 'insurerName',
  plan_year: 'planYear',
  plan_type: 'planType',
  network_type: 'networkType',
  metal_level: 'metalTier',
  metal_tier: 'metalTier',
  group_number: 'groupNumber',
  in_deductible_individual: 'deductibleIndividual',
  in_deductible_family: 'deductibleFamily',
  out_deductible_individual: 'outDeductibleIndividual',
  out_deductible_family: 'outDeductibleFamily',
  in_oop_max_individual: 'oopMaxIndividual',
  in_oop_max_family: 'oopMaxFamily',
  out_oop_max_individual: 'outOopMaxIndividual',
  out_oop_max_family: 'outOopMaxFamily',
  is_aca_compliant: 'isAcaCompliant',
  aca_compliance_basis: 'acaComplianceBasis',
};

/** @deprecated Use PLAN_IDENTITY_SNAKE_TO_CAMEL. Kept for back-compat. */
export const SNAKE_TO_CAMEL = PLAN_IDENTITY_SNAKE_TO_CAMEL;

/** Coinsurance fields exist in Opus + Haiku-comprehensive but are out-of-scope for plan-identity. */
export const OUT_OF_SCOPE_OPUS_FIELDS = new Set([
  'in_coinsurance_default',
  'out_coinsurance_default',
]);

/**
 * Normalize a raw key to canonical for a given parser site.
 *
 * Plan-identity: applies snake_to_camel mapping; returns camelCase canonical when
 *   raw key matches either the snake_case or camelCase form.
 * Other sites: passes camelCase keys through if they appear in the site's
 *   canonical_fields list.
 *
 * Returns null if the key is unknown (drift key OR out-of-scope) — caller decides
 * how to record (typically captured in drift_keys for diagnostic visibility).
 */
export function canonicalKeyOf(key: string, site: ParserSite): CanonicalField | null {
  const cfg = PARSER_SITE_REGISTRY[site];
  const canonicalSet = new Set<string>(cfg.canonical_fields);

  if (site === 'plan_identity') {
    // Snake-case mapping (Opus + Haiku-comprehensive artifacts)
    if (key in PLAN_IDENTITY_SNAKE_TO_CAMEL) {
      const camel = PLAN_IDENTITY_SNAKE_TO_CAMEL[key];
      return canonicalSet.has(camel) ? camel : null;
    }
    // Direct camelCase match
    return canonicalSet.has(key) ? key : null;
  }

  // New sites: calibration runners produce camelCase directly
  return canonicalSet.has(key) ? key : null;
}

export function isOutOfScopeOpusField(key: string): boolean {
  return OUT_OF_SCOPE_OPUS_FIELDS.has(key);
}
