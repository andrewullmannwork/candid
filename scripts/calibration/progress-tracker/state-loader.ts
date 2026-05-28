/**
 * Load existing JSON artifacts into normalized CalibrationState shape per parser_site.
 *
 * S138 PR2 extension: multi-site support via PARSER_SITE_REGISTRY in types.ts.
 *
 * Plan-identity (existing 5 states) — preserved from pre-PR2 harness:
 *   1. opus-extraction.json (Opus baseline; snake_case keys; mapped via field-mapping.ts)
 *   2. haiku-comprehensive-prompt.json (Haiku ceiling; snake_case keys)
 *   3. haiku-live-prod-prompt-with-supplement.json + haiku-live-prod-temp1-runs.json (DEFECT floor)
 *   4. haiku-temp-0-run-{1..5}.json (temp=0 baseline)
 *   5. haiku-tool-use-compat-test.json + haiku-tool-use-i7.json (tool-use baseline)
 *
 * New sites (sbc, plan_doc, eoc) — doc_keyed_with_prefix layout:
 *   - `<doc>/<prefix>haiku-defect-floor.json` (DEFECT floor)
 *   - `<doc>/<prefix>haiku-temp-0.json` (temp=0 baseline)
 *
 * New sites (code_identity, description_match) — site_subdir layout:
 *   - `<site-subdir>/<unit>/input.json` (the input — code or description)
 *   - `<site-subdir>/<unit>/haiku-defect-floor.json`
 *   - `<site-subdir>/<unit>/haiku-temp-0.json`
 *
 * Missing artifacts are returned as empty `by_doc: {}` rather than throwing —
 * supports incremental harness extension as calibration runners ship per-site.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { canonicalKeyOf, isOutOfScopeOpusField } from './field-mapping';
import type {
  CalibrationState,
  CanonicalField,
  FieldExtraction,
  ParserSite,
  RunArtifact,
} from './types';
import { PARSER_SITE_REGISTRY } from './types';

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

/** Map a raw response object (snake_case OR camelCase keys) to canonical fields for a given site. */
function normalizeFieldsRecord(
  raw: Record<string, unknown>,
  site: ParserSite,
): {
  fields: Partial<Record<CanonicalField, FieldExtraction>>;
  drift_keys: string[];
} {
  const fields: Partial<Record<CanonicalField, FieldExtraction>> = {};
  const drift_keys: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (isOutOfScopeOpusField(rawKey)) continue;
    if (rawKey.startsWith('_')) continue; // metadata keys like _run_metadata
    const canonical = canonicalKeyOf(rawKey, site);
    if (canonical) {
      fields[canonical] = normalizeFieldShape(rawValue);
    } else {
      drift_keys.push(rawKey);
    }
  }
  return { fields, drift_keys };
}

// ── Plan-identity loaders (preserved from pre-PR2 harness) ──────────────────

/**
 * Load Opus or Haiku-comprehensive: {doc_slug, extracted_at, extracted_by, fields, ...}.
 * The `fields` object has snake_case keys with {value, source_excerpt, ...} per field
 * (or sometimes bare scalars; normalizeFieldShape handles both).
 */
function loadOpusOrComprehensive(path: string, site: ParserSite): RunArtifact | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    fields?: Record<string, unknown>;
  };
  if (!data.fields) return null;
  const { fields, drift_keys } = normalizeFieldsRecord(data.fields, site);
  const raw_response = drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : undefined;
  return { fields, raw_response, parse_error: null };
}

/**
 * Load haiku-live-prod-prompt-with-supplement.json — TOP-LEVEL camelCase keys.
 * Each value is {value, source_excerpt}. Includes drift keys at top level.
 */
function loadLiveProdSupplement(path: string, site: ParserSite): RunArtifact | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const { fields, drift_keys } = normalizeFieldsRecord(data, site);
  const raw_response = drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : undefined;
  return { fields, raw_response, parse_error: null };
}

/**
 * Load haiku-temp-0-run-N.json — {parsed, raw, usage, elapsed_ms, parse_error}.
 * parsed has camelCase keys with {value, source_excerpt, ...} per field; may include drift keys.
 */
function loadTemp0Run(path: string, site: ParserSite): RunArtifact | null {
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
  const { fields, drift_keys } = normalizeFieldsRecord(data.parsed, site);
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
function loadToolUseTest(path: string, site: ParserSite): RunArtifact | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    tool_input?: Record<string, unknown>;
    usage?: { input_tokens: number; output_tokens: number };
    elapsed_ms?: number;
    cost_usd?: number;
  };
  if (!data.tool_input) return null;
  const { fields, drift_keys } = normalizeFieldsRecord(data.tool_input, site);
  return {
    fields,
    raw_response: drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : undefined,
    parse_error: null,
    usage: data.usage,
    elapsed_ms: data.elapsed_ms,
    cost_usd: data.cost_usd,
  };
}

/** Reusable inline loader for backfill multi-run JSON (mirrors loadTemp0Run shape). */
function loadTemp0RunInline(data: unknown, site: ParserSite): RunArtifact | null {
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
  const { fields, drift_keys } = normalizeFieldsRecord(d.parsed, site);
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

/** Build the plan-identity 5 known states from disk. */
function loadPlanIdentityStates(): CalibrationState[] {
  const site: ParserSite = 'plan_identity';
  const docs = PARSER_SITE_REGISTRY.plan_identity.doc_slugs;
  const states: CalibrationState[] = [];

  // 1. Opus baseline
  const opus: CalibrationState = {
    id: 'opus-baseline-2026-05-28',
    parser_site: site,
    label: 'Opus 4.7 reference extraction (S136 calibration)',
    date: '2026-05-28',
    session: 'S136',
    model: 'claude-opus-4-7',
    prompt: 'comprehensive',
    temperature: null,
    tool_use: false,
    by_doc: {},
  };
  for (const doc of docs) {
    const r = loadOpusOrComprehensive(resolve(VAULT_BASE, doc, 'opus-extraction.json'), site);
    if (r) opus.by_doc[doc] = [r];
  }
  states.push(opus);

  // 2. Haiku-comprehensive @ temp=1.0 (S136 ceiling)
  const haikuCeiling: CalibrationState = {
    id: 'haiku-comprehensive-temp1-2026-05-28',
    parser_site: site,
    label: 'Haiku 4.5 ceiling — comprehensive prompt @ temp=1.0 (S136)',
    date: '2026-05-28',
    session: 'S136',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'comprehensive',
    temperature: 1.0,
    tool_use: false,
    by_doc: {},
  };
  for (const doc of docs) {
    const r = loadOpusOrComprehensive(resolve(VAULT_BASE, doc, 'haiku-comprehensive-prompt.json'), site);
    if (r) haikuCeiling.by_doc[doc] = [r];
  }
  states.push(haikuCeiling);

  // 3. Haiku live-PROD prompt @ temp=1.0 (DEFECT floor; OAP single-run + multi-run backfill for other 4)
  const haikuFloor: CalibrationState = {
    id: 'haiku-live-prod-temp1-2026-05-28',
    parser_site: site,
    label: 'Haiku 4.5 DEFECT floor — live-PROD plan-identity prompt @ temp=1.0',
    date: '2026-05-28',
    session: 'S136',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'live-prod-plan-identity',
    temperature: 1.0,
    tool_use: false,
    by_doc: {},
  };
  for (const doc of docs) {
    const r = loadLiveProdSupplement(
      resolve(VAULT_BASE, doc, 'haiku-live-prod-prompt-with-supplement.json'),
      site,
    );
    if (r) haikuFloor.by_doc[doc] = [r];
    // Multi-run backfill file (5 runs per doc) — load if present.
    const backfillPath = resolve(VAULT_BASE, doc, 'haiku-live-prod-temp1-runs.json');
    if (existsSync(backfillPath)) {
      const raw = JSON.parse(readFileSync(backfillPath, 'utf-8')) as { runs: unknown[] };
      const runs: RunArtifact[] = (raw.runs || [])
        .map((r) => loadTemp0RunInline(r, site))
        .filter((r): r is RunArtifact => r !== null);
      if (runs.length > 0) haikuFloor.by_doc[doc] = runs;
    }
  }
  states.push(haikuFloor);

  // 4. Haiku temp=0 with live-PROD prompt (I1 + I6; 5 runs OAP, 1 run others)
  const haikuTemp0: CalibrationState = {
    id: 'haiku-live-prod-temp0-2026-05-28',
    parser_site: site,
    label: 'Haiku 4.5 @ temp=0 — live-PROD plan-identity prompt (I1 + I6)',
    date: '2026-05-28',
    session: 'S136 → S2',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'live-prod-plan-identity',
    temperature: 0,
    tool_use: false,
    by_doc: {},
  };
  for (const doc of docs) {
    const runs: RunArtifact[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = loadTemp0Run(resolve(VAULT_BASE, doc, `haiku-temp-0-run-${i}.json`), site);
      if (r) runs.push(r);
    }
    if (runs.length > 0) haikuTemp0.by_doc[doc] = runs;
  }
  states.push(haikuTemp0);

  // 5. Haiku temp=0 + tool-use (I2; OAP only — I7 backfill brings other 4 docs)
  const haikuToolUse: CalibrationState = {
    id: 'haiku-live-prod-temp0-toolUse-2026-05-28',
    parser_site: site,
    label: 'Haiku 4.5 @ temp=0 + tool-use — live-PROD plan-identity (I2 OAP + I7 backfill)',
    date: '2026-05-28',
    session: 'S2',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'live-prod-plan-identity-toolUse',
    temperature: 0,
    tool_use: true,
    by_doc: {},
  };
  for (const doc of docs) {
    const r = loadToolUseTest(resolve(VAULT_BASE, doc, 'haiku-tool-use-compat-test.json'), site);
    if (r) haikuToolUse.by_doc[doc] = [r];
    const i7Path = resolve(VAULT_BASE, doc, 'haiku-tool-use-i7.json');
    if (existsSync(i7Path)) {
      const r2 = loadToolUseTest(i7Path, site);
      if (r2) haikuToolUse.by_doc[doc] = [r2];
    }
  }
  states.push(haikuToolUse);

  return states;
}

// ── New-site loaders ────────────────────────────────────────────────────────

/**
 * Resolve the vault path for a (site, unit, artifact-name) triple.
 * doc_keyed_with_prefix → `<VAULT_BASE>/<unit>/<prefix><artifact>`
 * site_subdir          → `<VAULT_BASE>/<subdir>/<unit>/<artifact>`
 */
function resolveSitePath(site: ParserSite, unit: string, artifactBasename: string): string {
  const cfg = PARSER_SITE_REGISTRY[site];
  if (cfg.vault_layout === 'doc_keyed_with_prefix') {
    return resolve(VAULT_BASE, unit, `${cfg.vault_subdir_or_prefix}${artifactBasename}`);
  } else {
    return resolve(VAULT_BASE, cfg.vault_subdir_or_prefix, unit, artifactBasename);
  }
}

/**
 * Generic loader for new-site parser artifacts.
 *
 * Expected artifact JSON shape (per calibration runner output):
 *   { parsed: { <field>: { value, source_excerpt?, confidence?, ... }, ... },
 *     raw?: string, usage?, elapsed_ms?, cost_usd?, parse_error?: string }
 *
 * OR for tool-use runners (PR3+):
 *   { tool_input: { <field>: { value, source_excerpt, ... } }, usage?, elapsed_ms?, cost_usd? }
 */
function loadParserArtifact(path: string, site: ParserSite): RunArtifact | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    parsed?: Record<string, unknown> | null;
    tool_input?: Record<string, unknown>;
    raw?: string;
    usage?: { input_tokens: number; output_tokens: number };
    elapsed_ms?: number;
    cost_usd?: number;
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
  const fieldsRaw = data.tool_input ?? data.parsed;
  if (!fieldsRaw) return null;
  const { fields, drift_keys } = normalizeFieldsRecord(fieldsRaw, site);
  const cost_usd =
    data.cost_usd ??
    (data.usage
      ? (data.usage.input_tokens * 0.8) / 1_000_000 + (data.usage.output_tokens * 4.0) / 1_000_000
      : undefined);
  return {
    fields,
    raw_response: drift_keys.length > 0 ? `drift_keys:${drift_keys.join(',')}` : data.raw,
    parse_error: null,
    usage: data.usage,
    elapsed_ms: data.elapsed_ms,
    cost_usd,
  };
}

/**
 * Standard 2-state load for new sites: DEFECT floor (temp=1.0) + temp=0 baseline.
 * Each state may have 1+ runs per unit.
 */
function loadNewSiteStates(site: ParserSite): CalibrationState[] {
  const cfg = PARSER_SITE_REGISTRY[site];
  const states: CalibrationState[] = [];

  // DEFECT floor: temp=1.0 current PROD behavior
  const floor: CalibrationState = {
    id: cfg.defect_floor_state_id,
    parser_site: site,
    label: `${cfg.label} — DEFECT floor (live PROD prompt @ temp=1.0)`,
    date: '2026-05-28',
    session: 'S138',
    model: 'claude-haiku-4-5-20251001',
    prompt: `live-prod-${site}`,
    temperature: 1.0,
    tool_use: false,
    by_doc: {},
  };
  for (const unit of cfg.doc_slugs) {
    // Single run per unit at floor (or backfill multi-run if present)
    const r = loadParserArtifact(resolveSitePath(site, unit, 'haiku-defect-floor.json'), site);
    if (r) floor.by_doc[unit] = [r];
    // Multi-run variant: <prefix>haiku-defect-floor-runs.json with { runs: [...] }
    const multiPath = resolveSitePath(site, unit, 'haiku-defect-floor-runs.json');
    if (existsSync(multiPath)) {
      const raw = JSON.parse(readFileSync(multiPath, 'utf-8')) as { runs: unknown[] };
      const runs: RunArtifact[] = (raw.runs || [])
        .map((r) => loadTemp0RunInline(r, site))
        .filter((r): r is RunArtifact => r !== null);
      if (runs.length > 0) floor.by_doc[unit] = runs;
    }
  }
  states.push(floor);

  // temp=0 baseline: PR1 hypothesis target state
  const temp0: CalibrationState = {
    id: cfg.defect_floor_state_id.replace('defect-floor', 'temp-0'),
    parser_site: site,
    label: `${cfg.label} — temp=0 baseline (live PROD prompt @ temp=0)`,
    date: '2026-05-28',
    session: 'S138',
    model: 'claude-haiku-4-5-20251001',
    prompt: `live-prod-${site}`,
    temperature: 0,
    tool_use: false,
    by_doc: {},
  };
  for (const unit of cfg.doc_slugs) {
    const r = loadParserArtifact(resolveSitePath(site, unit, 'haiku-temp-0.json'), site);
    if (r) temp0.by_doc[unit] = [r];
  }
  states.push(temp0);

  // Optional Haiku-ceiling state (for sites where one is meaningful)
  if (cfg.ground_truth_haiku_ceiling_state_id) {
    const ceiling: CalibrationState = {
      id: cfg.ground_truth_haiku_ceiling_state_id,
      parser_site: site,
      label: `${cfg.label} — Haiku ceiling (comprehensive prompt @ temp=1.0)`,
      date: '2026-05-28',
      session: 'S138',
      model: 'claude-haiku-4-5-20251001',
      prompt: `comprehensive-${site}`,
      temperature: 1.0,
      tool_use: false,
      by_doc: {},
    };
    for (const unit of cfg.doc_slugs) {
      const r = loadParserArtifact(resolveSitePath(site, unit, 'haiku-ceiling.json'), site);
      if (r) ceiling.by_doc[unit] = [r];
    }
    // Only include the ceiling state if at least one unit produced artifacts (avoid empty-state noise).
    if (Object.keys(ceiling.by_doc).length > 0) states.push(ceiling);
  }

  return states;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function loadStatesForSite(site: ParserSite): CalibrationState[] {
  if (site === 'plan_identity') return loadPlanIdentityStates();
  return loadNewSiteStates(site);
}

/** Back-compat shim: returns plan-identity states only. Used by legacy callers. */
export function loadKnownStates(): CalibrationState[] {
  return loadPlanIdentityStates();
}

/** Load OCR text per (site, unit). For code/description sites, returns the input string. */
export function loadOcr(site: ParserSite, unit: string): string {
  const cfg = PARSER_SITE_REGISTRY[site];
  if (cfg.vault_layout === 'doc_keyed_with_prefix') {
    // SBC/EOC/plan-identity/plan_doc share doc-rooted OCR
    return readFileSync(resolve(VAULT_BASE, unit, 'ocr.txt'), 'utf-8');
  }
  // site_subdir: input.json carries `{ input: "<text>" }` or `{ ocr: "<text>" }`
  const inputPath = resolveSitePath(site, unit, 'input.json');
  if (!existsSync(inputPath)) return '';
  const data = JSON.parse(readFileSync(inputPath, 'utf-8')) as {
    input?: string;
    ocr?: string;
    description?: string;
    code?: string;
  };
  return data.input ?? data.ocr ?? data.description ?? data.code ?? '';
}
