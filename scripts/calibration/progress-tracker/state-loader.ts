/**
 * Load existing JSON artifacts into normalized CalibrationState shape.
 *
 * Supports artifact shapes:
 *   1. opus-extraction.json / haiku-comprehensive-prompt.json — {doc_slug, fields, ...}
 *      with snake_case keys; map via field-mapping.ts.
 *   2. haiku-live-prod-prompt-with-supplement.json — top-level camelCase keys with
 *      {value, source_excerpt} per field (S136 critical-review probe shape).
 *   3. haiku-temp-0-run-N.json — {parsed, raw, usage, elapsed_ms, parse_error};
 *      `parsed` has camelCase keys with {value, source_excerpt, ...} per field.
 *   4. haiku-tool-use-compat-test.json — {tool_input, usage, ...}; `tool_input`
 *      has 17 canonical keys with {value, source_excerpt, source_section_hint, confidence}.
 *
 * Each loader returns RunArtifact[] for one (state, doc) pair.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { canonicalKeyOf, isOutOfScopeOpusField } from './field-mapping';
import type {
  CalibrationState,
  CanonicalField,
  DocSlug,
  FieldExtraction,
  RunArtifact,
} from './types';
import { CALIBRATION_DOCS } from './types';

const VAULT_BASE =
  '/Users/andrewullmann/Desktop/du_weldenvarden/04_Professional/Airgetlam Labs LLC/Candid/plans/findings/opus-parser-calibration-2026-05-28';

interface RawFieldShape {
  value?: unknown;
  source_excerpt?: string | null;
  source_section_hint?: string | null;
  confidence?: number | null;
  null_justification?: string | null;
}

/** Normalize a raw field object (any shape) into FieldExtraction. */
function normalizeFieldShape(raw: unknown): FieldExtraction {
  if (raw === null || raw === undefined) {
    return { value: null, source_excerpt: null };
  }
  if (typeof raw === 'object') {
    const r = raw as RawFieldShape;
    return {
      value: r.value ?? null,
      source_excerpt: r.source_excerpt ?? null,
      source_section_hint: r.source_section_hint ?? null,
      confidence: r.confidence ?? null,
      null_justification: r.null_justification ?? null,
    };
  }
  // Bare scalar shape (some older artifacts have just `{planName: 'X'}` not wrapped) — treat as value-only.
  return { value: raw, source_excerpt: null };
}

/** Map a raw response object (snake_case OR camelCase keys) to canonical fields. */
function normalizeFieldsRecord(raw: Record<string, unknown>): {
  fields: Partial<Record<CanonicalField, FieldExtraction>>;
  drift_keys: string[];
} {
  const fields: Partial<Record<CanonicalField, FieldExtraction>> = {};
  const drift_keys: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (isOutOfScopeOpusField(rawKey)) continue;
    if (rawKey.startsWith('_')) continue; // metadata keys like _run_metadata
    const canonical = canonicalKeyOf(rawKey);
    if (canonical) {
      fields[canonical] = normalizeFieldShape(rawValue);
    } else {
      drift_keys.push(rawKey);
    }
  }
  return { fields, drift_keys };
}

/**
 * Load Opus or Haiku-comprehensive: {doc_slug, extracted_at, extracted_by, fields, ...}.
 * The `fields` object has snake_case keys with {value, source_excerpt, ...} per field
 * (or sometimes bare scalars; normalizeFieldShape handles both).
 */
function loadOpusOrComprehensive(path: string): RunArtifact | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    fields?: Record<string, unknown>;
  };
  if (!data.fields) return null;
  const { fields, drift_keys } = normalizeFieldsRecord(data.fields);
  // Stash drift keys in the raw response field for visibility (not expected for these states).
  const raw_response = drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : undefined;
  return { fields, raw_response, parse_error: null };
}

/**
 * Load haiku-live-prod-prompt-with-supplement.json — TOP-LEVEL camelCase keys.
 * Each value is {value, source_excerpt}. Includes drift keys at top level.
 */
function loadLiveProdSupplement(path: string): RunArtifact | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const { fields, drift_keys } = normalizeFieldsRecord(data);
  const raw_response = drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : undefined;
  return { fields, raw_response, parse_error: null };
}

/**
 * Load haiku-temp-0-run-N.json — {parsed, raw, usage, elapsed_ms, parse_error}.
 * parsed has camelCase keys with {value, source_excerpt, ...} per field; may include drift keys.
 */
function loadTemp0Run(path: string): RunArtifact | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    parsed?: Record<string, unknown> | null;
    raw?: string;
    usage?: { input_tokens: number; output_tokens: number };
    elapsed_ms?: number;
    parse_error?: string | null;
  };
  if (data.parse_error) {
    return {
      fields: {},
      raw_response: data.raw,
      parse_error: data.parse_error,
      usage: data.usage,
      elapsed_ms: data.elapsed_ms,
    };
  }
  if (!data.parsed) return null;
  const { fields, drift_keys } = normalizeFieldsRecord(data.parsed);
  const raw_response = drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : data.raw;
  const cost_usd =
    data.usage && data.elapsed_ms
      ? (data.usage.input_tokens * 0.8) / 1_000_000 + (data.usage.output_tokens * 4.0) / 1_000_000
      : undefined;
  return {
    fields,
    raw_response,
    parse_error: null,
    usage: data.usage,
    elapsed_ms: data.elapsed_ms,
    cost_usd,
  };
}

/** Load haiku-tool-use-compat-test.json — {tool_input, usage, ...}. */
function loadToolUseTest(path: string): RunArtifact | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    tool_input?: Record<string, unknown>;
    usage?: { input_tokens: number; output_tokens: number };
    elapsed_ms?: number;
    cost_usd?: number;
  };
  if (!data.tool_input) return null;
  const { fields, drift_keys } = normalizeFieldsRecord(data.tool_input);
  return {
    fields,
    raw_response: drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : undefined,
    parse_error: null,
    usage: data.usage,
    elapsed_ms: data.elapsed_ms,
    cost_usd: data.cost_usd,
  };
}

// ── State definitions ────────────────────────────────────────────────────────

/** Build the existing 5 known states from disk. */
export function loadKnownStates(): CalibrationState[] {
  const states: CalibrationState[] = [];

  // 1. Opus baseline (gold reference)
  const opus: CalibrationState = {
    id: 'opus-baseline-2026-05-28',
    label: 'Opus 4.7 reference extraction (S136 calibration)',
    date: '2026-05-28',
    session: 'S136',
    model: 'claude-opus-4-7',
    prompt: 'comprehensive',
    temperature: null,
    tool_use: false,
    by_doc: {},
  };
  for (const doc of CALIBRATION_DOCS) {
    const r = loadOpusOrComprehensive(resolve(VAULT_BASE, doc, 'opus-extraction.json'));
    if (r) opus.by_doc[doc] = [r];
  }
  states.push(opus);

  // 2. Haiku-comprehensive @ temp=1.0 (S136 ceiling)
  const haikuCeiling: CalibrationState = {
    id: 'haiku-comprehensive-temp1-2026-05-28',
    label: 'Haiku 4.5 ceiling — comprehensive prompt @ temp=1.0 (S136)',
    date: '2026-05-28',
    session: 'S136',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'comprehensive',
    temperature: 1.0,
    tool_use: false,
    by_doc: {},
  };
  for (const doc of CALIBRATION_DOCS) {
    const r = loadOpusOrComprehensive(resolve(VAULT_BASE, doc, 'haiku-comprehensive-prompt.json'));
    if (r) haikuCeiling.by_doc[doc] = [r];
  }
  states.push(haikuCeiling);

  // 3. Haiku live-PROD prompt @ temp=1.0 (DEFECT floor; OAP only — backfill brings other 4 docs)
  const haikuFloor: CalibrationState = {
    id: 'haiku-live-prod-temp1-2026-05-28',
    label: 'Haiku 4.5 DEFECT floor — live-PROD plan-identity prompt @ temp=1.0',
    date: '2026-05-28',
    session: 'S136',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'live-prod-plan-identity',
    temperature: 1.0,
    tool_use: false,
    by_doc: {},
  };
  for (const doc of CALIBRATION_DOCS) {
    const r = loadLiveProdSupplement(
      resolve(VAULT_BASE, doc, 'haiku-live-prod-prompt-with-supplement.json'),
    );
    if (r) haikuFloor.by_doc[doc] = [r];
    // Multi-run backfill file (5 runs per doc) — load if present.
    const backfillPath = resolve(VAULT_BASE, doc, 'haiku-live-prod-temp1-runs.json');
    if (existsSync(backfillPath)) {
      const raw = JSON.parse(readFileSync(backfillPath, 'utf-8')) as { runs: unknown[] };
      const runs: RunArtifact[] = (raw.runs || [])
        .map((r) => loadTemp0RunInline(r))
        .filter((r): r is RunArtifact => r !== null);
      haikuFloor.by_doc[doc] = runs.length > 0 ? runs : haikuFloor.by_doc[doc];
    }
  }
  states.push(haikuFloor);

  // 4. Haiku temp=0 with live-PROD prompt (I1 + I6; 5 runs OAP, 1 run others)
  const haikuTemp0: CalibrationState = {
    id: 'haiku-live-prod-temp0-2026-05-28',
    label: 'Haiku 4.5 @ temp=0 — live-PROD plan-identity prompt (I1 + I6)',
    date: '2026-05-28',
    session: 'S136 → S2',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'live-prod-plan-identity',
    temperature: 0,
    tool_use: false,
    by_doc: {},
  };
  for (const doc of CALIBRATION_DOCS) {
    const runs: RunArtifact[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = loadTemp0Run(resolve(VAULT_BASE, doc, `haiku-temp-0-run-${i}.json`));
      if (r) runs.push(r);
    }
    if (runs.length > 0) haikuTemp0.by_doc[doc] = runs;
  }
  states.push(haikuTemp0);

  // 5. Haiku temp=0 + tool-use (I2; OAP only — I7 backfill brings other 4 docs)
  const haikuToolUse: CalibrationState = {
    id: 'haiku-live-prod-temp0-toolUse-2026-05-28',
    label: 'Haiku 4.5 @ temp=0 + tool-use — live-PROD plan-identity (I2 OAP + I7 backfill)',
    date: '2026-05-28',
    session: 'S2',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'live-prod-plan-identity-toolUse',
    temperature: 0,
    tool_use: true,
    by_doc: {},
  };
  for (const doc of CALIBRATION_DOCS) {
    const r = loadToolUseTest(resolve(VAULT_BASE, doc, 'haiku-tool-use-compat-test.json'));
    if (r) haikuToolUse.by_doc[doc] = [r];
    // I7 backfill: single-run-per-doc artifacts.
    const i7Path = resolve(VAULT_BASE, doc, 'haiku-tool-use-i7.json');
    if (existsSync(i7Path)) {
      const r2 = loadToolUseTest(i7Path);
      if (r2) haikuToolUse.by_doc[doc] = [r2];
    }
  }
  states.push(haikuToolUse);

  return states;
}

/** Reusable inline loader for backfill multi-run JSON (mirrors loadTemp0Run shape). */
function loadTemp0RunInline(data: unknown): RunArtifact | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as {
    parsed?: Record<string, unknown> | null;
    raw?: string;
    usage?: { input_tokens: number; output_tokens: number };
    elapsed_ms?: number;
    parse_error?: string | null;
  };
  if (d.parse_error) {
    return {
      fields: {},
      raw_response: d.raw,
      parse_error: d.parse_error,
      usage: d.usage,
      elapsed_ms: d.elapsed_ms,
    };
  }
  if (!d.parsed) return null;
  const { fields, drift_keys } = normalizeFieldsRecord(d.parsed);
  const raw_response = drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : d.raw;
  const cost_usd =
    d.usage && d.elapsed_ms
      ? (d.usage.input_tokens * 0.8) / 1_000_000 + (d.usage.output_tokens * 4.0) / 1_000_000
      : undefined;
  return {
    fields,
    raw_response,
    parse_error: null,
    usage: d.usage,
    elapsed_ms: d.elapsed_ms,
    cost_usd,
  };
}

/** Load OCR text per doc. */
export function loadOcr(doc: DocSlug): string {
  return readFileSync(resolve(VAULT_BASE, doc, 'ocr.txt'), 'utf-8');
}
