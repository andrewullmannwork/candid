/**
 * Option E — derive per-(doc, field) ground truth from ceiling states.
 *
 * S138 PR2 extension: per-site axis added. Sites without an Opus baseline rely on
 * single_source semantics (Haiku-comprehensive ceiling alone serves as GT source).
 * Sites without any ceiling state (e.g., when calibration runner hasn't shipped
 * yet) produce empty ground truth — all fields scored as 'unknown'.
 *
 * Logic per (site, doc, field):
 *   - Both Opus + Haiku ceiling sources non-null AND values agree → present_in_doc='yes', value=Opus value
 *   - Both ceiling sources null → present_in_doc='no'
 *   - One non-null + one null (OR both non-null but disagree) → present_in_doc='ambiguous'
 *   - Field missing from BOTH ceiling sources → present_in_doc='unknown'
 *   - Only one ceiling source covers field → single_source=true
 *   - No Opus state defined for this site → Haiku ceiling becomes sole GT source
 *     (single_source=true on every entry)
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type {
  CalibrationState,
  CanonicalField,
  GroundTruth,
  GroundTruthEntry,
  ParserSite,
} from './types';
import { PARSER_SITE_REGISTRY } from './types';

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

export function deriveGroundTruth(states: CalibrationState[], site: ParserSite): GroundTruth {
  const cfg = PARSER_SITE_REGISTRY[site];
  const opusStateId = cfg.ground_truth_opus_state_id;
  const ceilingStateId = cfg.ground_truth_haiku_ceiling_state_id;

  const opus = opusStateId ? states.find((s) => s.id === opusStateId) : null;
  const ceiling = ceilingStateId ? states.find((s) => s.id === ceilingStateId) : null;

  // No ceiling states available → empty GT (all fields scored as 'unknown')
  if (!opus && !ceiling) {
    const gt: GroundTruth = {};
    for (const doc of cfg.doc_slugs) {
      gt[doc] = {};
      for (const field of cfg.canonical_fields) {
        gt[doc]![field] = {
          present_in_doc: 'unknown',
          value: null,
          opus_excerpt: null,
          haiku_ceiling_excerpt: null,
          single_source: false,
          notes: 'No ceiling state available for this site yet',
        };
      }
    }
    return gt;
  }

  const gt: GroundTruth = {};

  for (const doc of cfg.doc_slugs) {
    const opusRuns = opus?.by_doc[doc];
    const ceilingRuns = ceiling?.by_doc[doc];
    if (!opusRuns?.[0] && !ceilingRuns?.[0]) continue;
    const opusFields = opusRuns?.[0]?.fields ?? {};
    const ceilingFields = ceilingRuns?.[0]?.fields ?? {};

    gt[doc] = {};

    for (const field of cfg.canonical_fields) {
      const opusF = opusFields[field];
      const ceilingF = ceilingFields[field];

      // Both sources missing this field entry entirely
      if (!opusF && !ceilingF) {
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
      const ceilingVal = ceilingF?.value ?? null;

      // Only one source covers this field (or site has no Opus by design)
      if (!opusF && ceilingF) {
        gt[doc]![field] = {
          present_in_doc: ceilingVal === null ? 'no' : 'yes',
          value: ceilingVal,
          opus_excerpt: null,
          haiku_ceiling_excerpt: ceilingF.source_excerpt ?? null,
          single_source: true,
          notes: opus
            ? 'Opus does not cover this field; Haiku-ceiling is sole GT source'
            : 'No Opus baseline for this site; Haiku-ceiling is sole GT source',
        };
        continue;
      }
      if (opusF && !ceilingF) {
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
      const ceilingEntry = ceilingF as NonNullable<typeof ceilingF>;
      if (opusVal === null && ceilingVal === null) {
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
      if (opusVal !== null && ceilingVal !== null && valuesAgree(opusVal, ceilingVal)) {
        gt[doc]![field] = {
          present_in_doc: 'yes',
          value: opusVal,
          opus_excerpt: opusEntry.source_excerpt ?? null,
          haiku_ceiling_excerpt: ceilingEntry.source_excerpt ?? null,
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
        haiku_ceiling_excerpt: ceilingEntry.source_excerpt ?? null,
        single_source: false,
        notes: `Ambiguous: opus=${JSON.stringify(opusVal)} haiku-ceiling=${JSON.stringify(ceilingVal)}`,
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
 *   { "<site>": { "<doc-slug>": { "<canonical-field>": { value: <truth>, rationale: "..." } } } }
 *
 * S138 PR2 extension: keyed by site at the top level so each parser site has its own
 * adjudication overlay. Pre-PR2 file shape (flat doc→field map) auto-detected and
 * promoted to plan_identity site for backwards compatibility.
 */
export interface GoldOverride {
  value: unknown;
  rationale: string;
}
export type GoldOverrides = Partial<Record<ParserSite, Record<string, Partial<Record<CanonicalField, GoldOverride>>>>>;

const VAULT_BASE =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/opus-parser-calibration-2026-05-28';

export function loadGoldOverrides(): GoldOverrides {
  const path = resolve(VAULT_BASE, 'gold_overrides.json');
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!raw || typeof raw !== 'object') return {};

  // Detect shape: is it the new {site: {doc: {field: ...}}} layout, OR the pre-PR2
  // flat {doc: {field: ...}} layout that implicitly meant plan_identity?
  // `_meta` keys are allowed in both layouts (metadata, not site/doc data).
  const obj = raw as Record<string, unknown>;
  const KNOWN_SITES = ['plan_identity', 'sbc', 'plan_doc', 'code_identity', 'description_match', 'eoc'];
  const nonMetaKeys = Object.keys(obj).filter((k) => k !== '_meta');
  const looksLikeSiteKeyed = nonMetaKeys.length > 0 && nonMetaKeys.every((k) => KNOWN_SITES.includes(k));
  if (looksLikeSiteKeyed) {
    // Strip `_meta` from the returned overrides (it's documentation, not field data)
    const { _meta: _ignored, ...siteData } = obj;
    void _ignored;
    return siteData as GoldOverrides;
  }
  // Legacy flat layout — promote to plan_identity (drop `_meta` if present)
  const { _meta: _ignored, ...flatData } = obj;
  void _ignored;
  return { plan_identity: flatData as Record<string, Partial<Record<CanonicalField, GoldOverride>>> };
}

export function applyGoldOverrides(
  gt: GroundTruth,
  overrides: GoldOverrides,
  site: ParserSite,
): GroundTruth {
  const result: GroundTruth = JSON.parse(JSON.stringify(gt));
  const siteOverrides = overrides[site] ?? {};
  for (const [doc, fields] of Object.entries(siteOverrides)) {
    if (!result[doc]) result[doc] = {};
    for (const [field, override] of Object.entries(fields ?? {})) {
      const o = override as GoldOverride;
      const prior = result[doc]![field as CanonicalField];
      result[doc]![field as CanonicalField] = {
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
