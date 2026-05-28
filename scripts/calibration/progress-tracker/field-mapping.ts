/**
 * Map snake_case (Opus + Haiku-comprehensive convention) → camelCase canonical.
 *
 * Live PROD plan-identity.ts uses camelCase. PR3 tool-use schema uses camelCase.
 * Opus extractions + S136 Haiku-comprehensive baseline use snake_case (cold-start
 * convention). Harness canonicalizes on camelCase.
 *
 * Drift keys (e.g., `deductibleOutOfNetworkIndividual`) are NOT mapped — they're
 * captured separately as drift signals.
 */

import type { CanonicalField } from './types';

export const SNAKE_TO_CAMEL: Record<string, CanonicalField> = {
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

/** Coinsurance fields exist in Opus + Haiku-comprehensive but are out-of-scope for plan-identity. */
export const OUT_OF_SCOPE_OPUS_FIELDS = new Set([
  'in_coinsurance_default',
  'out_coinsurance_default',
]);

/**
 * Normalize a raw key to canonical (camelCase). Returns null if the key is unknown
 * (drift key OR out-of-scope) — caller decides how to record.
 */
export function canonicalKeyOf(key: string): CanonicalField | null {
  if (key in SNAKE_TO_CAMEL) return SNAKE_TO_CAMEL[key];
  // Already camelCase canonical? Match against the canonical list.
  // (Avoids importing CANONICAL_PLAN_IDENTITY_FIELDS to avoid circular import; trust the lookup.)
  const camel = [
    'planName',
    'insurerName',
    'planYear',
    'planType',
    'networkType',
    'metalTier',
    'groupNumber',
    'deductibleIndividual',
    'deductibleFamily',
    'outDeductibleIndividual',
    'outDeductibleFamily',
    'oopMaxIndividual',
    'oopMaxFamily',
    'outOopMaxIndividual',
    'outOopMaxFamily',
    'isAcaCompliant',
    'acaComplianceBasis',
  ] as const;
  if ((camel as readonly string[]).includes(key)) return key as CanonicalField;
  return null;
}

export function isOutOfScopeOpusField(key: string): boolean {
  return OUT_OF_SCOPE_OPUS_FIELDS.has(key);
}
