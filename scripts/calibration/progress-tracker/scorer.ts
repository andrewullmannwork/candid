/**
 * Per-(state, doc, field) scorer.
 *
 * S138 PR2 extension: per-site axis. Each state belongs to a parser_site; the
 * scorer iterates that site's `canonical_fields` + `doc_slugs` via
 * PARSER_SITE_REGISTRY.
 *
 * For each canonical field in a state's doc-run(s):
 *   - Pattern P-8 verify source_excerpt against OCR (when OCR available + excerpt present)
 *   - Compare value against ground truth (Option E)
 *   - Compare value against Opus reference (informational; only for sites with Opus)
 *   - Detect drift_key, format_failure, spurious_null
 *
 * Aggregation rule for multi-run states (e.g., 5-run temp=1.0 baseline):
 *   - A field is "verified" if the modal (most common) value's excerpt verifies
 *   - format_failure_count = count of runs with parse_error or empty fields
 *   - drift_keys = union of drift_keys across runs
 *   - Cost + latency aggregated (sum cost, p50 latency)
 *
 * Single-run states use the single run directly.
 */

import type {
  CalibrationState,
  CanonicalField,
  DocScore,
  FieldExtraction,
  FieldScore,
  GroundTruth,
  ParserSite,
  RunArtifact,
  StateScore,
} from './types';
import { PARSER_SITE_REGISTRY } from './types';
import { verifyExcerpt } from './verifier';

/** Get the Opus value/excerpt for a (site, doc, field) — used as reference signal. */
function getOpusReference(
  states: CalibrationState[],
  site: ParserSite,
  doc: string,
  field: CanonicalField,
): { value: unknown; excerpt: string | null } {
  const cfg = PARSER_SITE_REGISTRY[site];
  if (!cfg.ground_truth_opus_state_id) return { value: null, excerpt: null };
  const opus = states.find((s) => s.id === cfg.ground_truth_opus_state_id);
  const opusF = opus?.by_doc[doc]?.[0]?.fields[field];
  return { value: opusF?.value ?? null, excerpt: opusF?.source_excerpt ?? null };
}

function valuesAgree(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const aNum = typeof a === 'number' ? a : typeof a === 'string' ? Number(a) : NaN;
  const bNum = typeof b === 'number' ? b : typeof b === 'string' ? Number(b) : NaN;
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum === bNum;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return a === b;
}

/** Aggregate multiple FieldExtractions into a single representative one (used for multi-run states). */
function aggregateField(extractions: FieldExtraction[]): FieldExtraction & { agreement: number } {
  if (extractions.length === 0) return { value: null, source_excerpt: null, agreement: 0 };
  if (extractions.length === 1) return { ...extractions[0], agreement: 1 };
  // Find the modal value across runs
  const counts = new Map<string, { count: number; rep: FieldExtraction }>();
  for (const e of extractions) {
    const key = JSON.stringify(e.value);
    const cur = counts.get(key);
    if (cur) cur.count += 1;
    else counts.set(key, { count: 1, rep: e });
  }
  let bestKey: string | null = null;
  let bestCount = 0;
  for (const [k, v] of counts) {
    if (v.count > bestCount) {
      bestKey = k;
      bestCount = v.count;
    }
  }
  const winner = bestKey !== null ? counts.get(bestKey)!.rep : extractions[0];
  return { ...winner, agreement: bestCount / extractions.length };
}

/** Drift keys: union across runs of (raw_response keys that didn't map to canonical fields). */
function extractDriftKeys(runs: RunArtifact[]): string[] {
  const set = new Set<string>();
  for (const r of runs) {
    if (r.raw_response && r.raw_response.startsWith('drift_keys:')) {
      r.raw_response
        .slice('drift_keys:'.length)
        .split(',')
        .forEach((k) => {
          if (k) set.add(k);
        });
    }
  }
  return Array.from(set).sort();
}

function scoreField(args: {
  site: ParserSite;
  doc: string;
  field: CanonicalField;
  haikuField: FieldExtraction | undefined;
  ocrText: string;
  groundTruth: GroundTruth;
  states: CalibrationState[];
}): FieldScore {
  const { site, doc, field, haikuField, ocrText, groundTruth, states } = args;
  const haikuValue = haikuField?.value ?? null;
  const haikuExcerpt = haikuField?.source_excerpt ?? null;

  const verify = verifyExcerpt(haikuExcerpt, ocrText);
  const gt = groundTruth[doc]?.[field];
  const opusRef = getOpusReference(states, site, doc, field);

  const gtPresent = gt?.present_in_doc;
  const gtAmbiguous = gtPresent === 'ambiguous' || gtPresent === 'unknown';

  // Verified = source_excerpt round-trips against OCR (the primary Pattern P-8 check)
  const verified = haikuValue !== null && verify.verified;

  // Verified-null = value is null AND ground truth confirms absence
  const verified_null = haikuValue === null && gtPresent === 'no';

  // Unverifiable = value non-null but excerpt doesn't verify (silent regression signal)
  const unverifiable = haikuValue !== null && !verify.verified;

  // Spurious null = value null but ground truth says field IS in doc
  const spurious_null = haikuValue === null && gtPresent === 'yes';

  // Opus reference (informational; doesn't penalize). Only meaningful for sites with Opus.
  const agrees_with_opus = opusRef.value !== null && valuesAgree(haikuValue, opusRef.value);
  const disagrees_with_opus =
    opusRef.value !== null && haikuValue !== null && !valuesAgree(haikuValue, opusRef.value);

  // Value-vs-GT match — stricter than excerpt verification
  let value_match: FieldScore['value_match'];
  if (gtPresent === 'unknown') {
    value_match = 'unscored_unknown';
  } else if (gtPresent === 'ambiguous') {
    value_match = 'unscored_ambiguous';
  } else if (gtPresent === 'yes') {
    if (haikuValue !== null && valuesAgree(haikuValue, gt?.value)) {
      value_match = 'correct';
    } else {
      value_match = 'wrong';
    }
  } else {
    // gtPresent === 'no'
    if (haikuValue === null) {
      value_match = 'verified_absent';
    } else {
      value_match = 'false_positive';
    }
  }

  return {
    field,
    haiku_value: haikuValue,
    haiku_excerpt: haikuExcerpt,
    verified,
    verify_method: verify.method,
    verified_null,
    unverifiable,
    spurious_null,
    drift_key: null, // computed at doc-level (drift is a raw-response property, not per-field)
    agrees_with_opus,
    disagrees_with_opus,
    ground_truth_ambiguous: gtAmbiguous,
    value_match,
  };
}

export function scoreDoc(args: {
  state: CalibrationState;
  doc: string;
  ocrText: string;
  groundTruth: GroundTruth;
  states: CalibrationState[];
}): DocScore | null {
  const { state, doc, ocrText, groundTruth, states } = args;
  const runs = state.by_doc[doc];
  if (!runs || runs.length === 0) return null;

  const cfg = PARSER_SITE_REGISTRY[state.parser_site];
  const format_failure_count = runs.filter((r) => r.parse_error !== null).length;
  const drift_keys = extractDriftKeys(runs);
  const cost_usd_total = runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const latencies = runs.map((r) => r.elapsed_ms ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const latency_ms_p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null;

  const per_field: FieldScore[] = [];
  for (const field of cfg.canonical_fields) {
    const extractions = runs.map((r) => r.fields[field]).filter((f): f is FieldExtraction => f !== undefined);
    if (extractions.length === 0) {
      // No extraction at all (drift or omission) — treat as null value
      const fakeField: FieldExtraction = { value: null, source_excerpt: null };
      const score = scoreField({
        site: state.parser_site,
        doc,
        field,
        haikuField: fakeField,
        ocrText,
        groundTruth,
        states,
      });
      per_field.push(score);
      continue;
    }
    const aggregated = aggregateField(extractions);
    const score = scoreField({
      site: state.parser_site,
      doc,
      field,
      haikuField: aggregated,
      ocrText,
      groundTruth,
      states,
    });
    per_field.push(score);
  }

  return {
    doc,
    state_id: state.id,
    per_field,
    fields_verifiable: per_field.filter((f) => f.verified).length,
    verified_null_count: per_field.filter((f) => f.verified_null).length,
    unverifiable_count: per_field.filter((f) => f.unverifiable).length,
    spurious_null_count: per_field.filter((f) => f.spurious_null).length,
    drift_count: drift_keys.length,
    drift_keys,
    agreement_with_opus_count: per_field.filter((f) => f.agrees_with_opus).length,
    disagreement_with_opus_count: per_field.filter((f) => f.disagrees_with_opus).length,
    format_failure_count,
    total_runs: runs.length,
    cost_usd_total,
    latency_ms_p50,
    value_correct_count: per_field.filter((f) => f.value_match === 'correct').length,
    value_wrong_count: per_field.filter((f) => f.value_match === 'wrong').length,
    value_verified_absent_count: per_field.filter((f) => f.value_match === 'verified_absent').length,
    value_false_positive_count: per_field.filter((f) => f.value_match === 'false_positive').length,
    value_unscored_unknown_count: per_field.filter((f) => f.value_match === 'unscored_unknown').length,
    value_unscored_ambiguous_count: per_field.filter((f) => f.value_match === 'unscored_ambiguous').length,
  };
}

export function scoreState(args: {
  state: CalibrationState;
  ocrByDoc: Record<string, string>;
  groundTruth: GroundTruth;
  allStates: CalibrationState[];
}): StateScore {
  const { state, ocrByDoc, groundTruth, allStates } = args;
  const cfg = PARSER_SITE_REGISTRY[state.parser_site];
  const by_doc: Record<string, DocScore> = {};
  for (const doc of cfg.doc_slugs) {
    const ocrText = ocrByDoc[doc] ?? '';
    // For code/description sites OCR may be the input string itself; verifier
    // handles empty-OCR gracefully by marking excerpts unverifiable.
    const ds = scoreDoc({ state, doc, ocrText, groundTruth, states: allStates });
    if (ds) by_doc[doc] = ds;
  }
  return {
    state_id: state.id,
    state_label: state.label,
    parser_site: state.parser_site,
    by_doc,
  };
}
