/**
 * Option E — derive per-(doc, field) ground truth from ceiling states.
 *
 * Inputs: Opus baseline + Haiku-comprehensive baseline states.
 * Output: GroundTruth — one entry per (doc, canonical_field).
 *
 * Logic:
 *   - Both ceiling sources non-null AND values agree → present_in_doc='yes', value=Opus value
 *   - Both ceiling sources null → present_in_doc='no'
 *   - One non-null + one null (OR both non-null but disagree) → present_in_doc='ambiguous'
 *   - Field missing from BOTH ceiling sources → present_in_doc='unknown' (Opus doesn't cover ACA fields)
 *   - Field present in only ONE ceiling source → single_source=true; treat as 'yes' with caveat
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { CalibrationState, CanonicalField, DocSlug, GroundTruth, GroundTruthEntry } from './types';
import { CANONICAL_PLAN_IDENTITY_FIELDS, CALIBRATION_DOCS } from './types';

const OPUS_STATE_ID = 'opus-baseline-2026-05-28';
const HAIKU_CEILING_STATE_ID = 'haiku-comprehensive-temp1-2026-05-28';

/** Equality check tolerant to string/number normalization. */
function valuesAgree(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // Numeric equality, accepting string-form numbers
  const aNum = typeof a === 'number' ? a : typeof a === 'string' ? Number(a) : NaN;
  const bNum = typeof b === 'number' ? b : typeof b === 'string' ? Number(b) : NaN;
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum === bNum;
  // String equality (case-insensitive, trimmed)
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return a === b;
}

export function deriveGroundTruth(states: CalibrationState[]): GroundTruth {
  const opus = states.find((s) => s.id === OPUS_STATE_ID);
  const haikuCeiling = states.find((s) => s.id === HAIKU_CEILING_STATE_ID);
  if (!opus || !haikuCeiling) {
    throw new Error('Ground truth derivation requires both Opus + Haiku-comprehensive ceiling states');
  }

  const gt: GroundTruth = {};

  for (const doc of CALIBRATION_DOCS) {
    const opusRuns = opus.by_doc[doc];
    const haikuRuns = haikuCeiling.by_doc[doc];
    if (!opusRuns?.[0] && !haikuRuns?.[0]) continue;
    const opusFields = opusRuns?.[0]?.fields ?? {};
    const haikuFields = haikuRuns?.[0]?.fields ?? {};

    gt[doc] = {};

    for (const field of CANONICAL_PLAN_IDENTITY_FIELDS) {
      const opusF = opusFields[field];
      const haikuF = haikuFields[field];

      // Both sources missing this field entry entirely
      if (!opusF && !haikuF) {
        gt[doc]![field] = {
          present_in_doc: 'unknown',
          value: null,
          opus_excerpt: null,
          haiku_ceiling_excerpt: null,
          single_source: false,
          notes: 'Neither ceiling source includes this field',
        };
        continue;
      }

      const opusVal = opusF?.value ?? null;
      const haikuVal = haikuF?.value ?? null;

      // Only one source covers this field
      if (!opusF && haikuF) {
        gt[doc]![field] = {
          present_in_doc: haikuVal === null ? 'no' : 'yes',
          value: haikuVal,
          opus_excerpt: null,
          haiku_ceiling_excerpt: haikuF.source_excerpt ?? null,
          single_source: true,
          notes: 'Opus does not cover this field; Haiku-ceiling is the only ground-truth source',
        };
        continue;
      }
      if (opusF && !haikuF) {
        gt[doc]![field] = {
          present_in_doc: opusVal === null ? 'no' : 'yes',
          value: opusVal,
          opus_excerpt: opusF.source_excerpt ?? null,
          haiku_ceiling_excerpt: null,
          single_source: true,
          notes: 'Haiku-ceiling does not cover this field; Opus is the only ground-truth source',
        };
        continue;
      }

      // Both sources cover this field; apply consistency logic
      const opusEntry = opusF as NonNullable<typeof opusF>;
      const haikuEntry = haikuF as NonNullable<typeof haikuF>;
      if (opusVal === null && haikuVal === null) {
        gt[doc]![field] = {
          present_in_doc: 'no',
          value: null,
          opus_excerpt: null,
          haiku_ceiling_excerpt: null,
          single_source: false,
          notes: 'Both ceiling sources agree: field genuinely absent',
        };
        continue;
      }
      if (opusVal !== null && haikuVal !== null && valuesAgree(opusVal, haikuVal)) {
        gt[doc]![field] = {
          present_in_doc: 'yes',
          value: opusVal,
          opus_excerpt: opusEntry.source_excerpt ?? null,
          haiku_ceiling_excerpt: haikuEntry.source_excerpt ?? null,
          single_source: false,
          notes: 'Both ceiling sources agree on non-null value',
        };
        continue;
      }
      // Ambiguous — one null + one non-null, OR both non-null but disagree
      gt[doc]![field] = {
        present_in_doc: 'ambiguous',
        value: null,
        opus_excerpt: opusEntry.source_excerpt ?? null,
        haiku_ceiling_excerpt: haikuEntry.source_excerpt ?? null,
        single_source: false,
        notes: `Ambiguous: opus=${JSON.stringify(opusVal)} haiku-ceiling=${JSON.stringify(haikuVal)}`,
      };
    }
  }

  return gt;
}

/**
 * Gold-overrides overlay — manual adjudication for unknown/ambiguous GT fields.
 *
 * Per Andrew direction (2026-05-28): "neither Opus nor Haiku-ceiling can be gold;
 * adjudicate disagreements + unknown-GT fields manually". Overlay structure:
 *
 *   { "<doc-slug>": { "<canonical-field>": { value: <truth>, rationale: "..." } } }
 *
 * When loaded, overrides replace the auto-derived GT entry: `present_in_doc='yes'`
 * if override value is non-null; `'no'` if null. The override `value` becomes the
 * ground-truth value used by `value_matches_ground_truth` scoring.
 *
 * Adjudication is conservative: only set overrides when the OCR + reasoning support
 * a clear truth. Otherwise leave as 'unknown' (the scorer marks those as
 * `unscored_unknown` — they don't penalize or credit).
 */
export interface GoldOverride {
  value: unknown;
  rationale: string;
}
export type GoldOverrides = Partial<Record<DocSlug, Partial<Record<CanonicalField, GoldOverride>>>>;

const VAULT_BASE =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/opus-parser-calibration-2026-05-28';

export function loadGoldOverrides(): GoldOverrides {
  const path = resolve(VAULT_BASE, 'gold_overrides.json');
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as GoldOverrides;
  return raw;
}

export function applyGoldOverrides(gt: GroundTruth, overrides: GoldOverrides): GroundTruth {
  const result: GroundTruth = JSON.parse(JSON.stringify(gt));
  for (const [doc, fields] of Object.entries(overrides)) {
    if (!result[doc as DocSlug]) result[doc as DocSlug] = {};
    for (const [field, override] of Object.entries(fields ?? {})) {
      const o = override as GoldOverride;
      const prior = result[doc as DocSlug]![field as CanonicalField];
      result[doc as DocSlug]![field as CanonicalField] = {
        present_in_doc: o.value === null ? 'no' : 'yes',
        value: o.value,
        opus_excerpt: prior?.opus_excerpt ?? null,
        haiku_ceiling_excerpt: prior?.haiku_ceiling_excerpt ?? null,
        single_source: false,
        notes: `Adjudicated: ${o.rationale}`,
      };
    }
  }
  return result;
}

export function summarizeGroundTruth(gt: GroundTruth): {
  per_doc: Record<string, { yes: number; no: number; ambiguous: number; unknown: number; single_source: number }>;
  total: { yes: number; no: number; ambiguous: number; unknown: number; single_source: number };
} {
  const per_doc: Record<string, { yes: number; no: number; ambiguous: number; unknown: number; single_source: number }> = {};
  const total = { yes: 0, no: 0, ambiguous: 0, unknown: 0, single_source: 0 };
  for (const [doc, fields] of Object.entries(gt)) {
    const counts = { yes: 0, no: 0, ambiguous: 0, unknown: 0, single_source: 0 };
    for (const entry of Object.values(fields ?? {})) {
      const e = entry as GroundTruthEntry;
      counts[e.present_in_doc] += 1;
      total[e.present_in_doc] += 1;
      if (e.single_source) {
        counts.single_source += 1;
        total.single_source += 1;
      }
    }
    per_doc[doc] = counts;
  }
  return { per_doc, total };
}
