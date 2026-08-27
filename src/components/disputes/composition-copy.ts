/**
 * composition-copy — S326 eleven-rules Rule 1: the composition step's NEUTRAL
 * fact templates, ONE fixture-scannable home.
 *
 * The line between permitted and prohibited (models doc §I.3 Rule 1, verified
 * holdings): a sentence whose subject is a DOCUMENT'S CONTENT is a fact
 * ("this code appears twice on the same date"); a sentence whose subject is
 * the member's LEGAL POSITION is characterization ("this is a duplicate-
 * billing violation") and never renders here. The fact-copy-guard fixture
 * scans THIS file's strings against the banned-verdict vocabulary — add copy
 * here, not inline in components, so the guard can't be routed around.
 *
 * Dollars ARE facts (document arithmetic — billed amounts, reference rates);
 * they render in fact statements and never as per-ground recovery badges
 * (Andrew's Q1 ruling, S326).
 */

// Client-safe re-export: the litigation-hold copy + step id live in
// letter-access (pure, no server imports) — ONE home, both surfaces.
export { LITIGATION_HOLD_MESSAGE, LITIGATION_STEP_ID as LITIGATION_STEP_ID_UI } from '@/lib/disputes/letter-access';

/** A neutral fact the composition step renders — built by the caller from the
 *  claim rows it already holds (no new fetch; the same parsed data that
 *  becomes the letter's audit-report input). */
export interface CompositionFact {
  lineNumber?: number | null;
  description?: string | null;
  code?: string | null;
  billedAmount?: number | null;
  /** The audit finding type this fact came from (drives the template + the
   *  static fact→ground mapping); null for plain line facts. */
  findingType?: string | null;
  benchmarkAmount?: number | null;
}

const fmt = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * Per-finding-type neutral sentences. Subject = the document's content, every
 * time. A type absent here renders its base line only (never a fallback to
 * the finding's own characterizing description).
 */
export const COMPOSITION_FACT_TEMPLATES: Record<string, (f: CompositionFact) => string> = {
  duplicate: () => 'This code appears more than once on the same date of service.',
  overcharge: (f) =>
    f.benchmarkAmount != null
      ? `The public reference rate for this code is ${fmt(f.benchmarkAmount)}.`
      : 'The billed amount is above the public reference rate for this code.',
  balance_billing: () =>
    'The billed amount is above the plan-allowed amount shown in your records.',
  unbundling: () => 'These codes are components of a single bundled procedure code.',
  missing_adjustment: () =>
    'Your EOB shows an adjustment that does not appear on this bill.',
  insurance_underpayment: () =>
    'Your EOB and this bill state different insurer payment amounts for this line.',
  zero_cost_share_overcharge: () =>
    'Your plan documents list a $0 share for this service; the bill shows a charge to you.',
  unallocated_balance: () =>
    "The bill's line amounts and reductions do not add up to its stated total.",
  chargemaster: () =>
    "The billed amount is above this provider's own published price for this code.",
  upcoding: () =>
    'Records for comparable services commonly carry a different billing code.',
};

/** Render one fact line: the base document facts + the type's neutral sentence. */
export function factStatement(f: CompositionFact): string {
  const parts: string[] = [];
  const head = [
    f.lineNumber != null ? `Line ${f.lineNumber}` : null,
    f.description || null,
    f.code ? `(${f.code})` : null,
  ]
    .filter(Boolean)
    .join(' — ');
  if (head) parts.push(head);
  if (f.billedAmount != null && f.billedAmount > 0) parts.push(`billed ${fmt(f.billedAmount)}`);
  const template = f.findingType ? COMPOSITION_FACT_TEMPLATES[f.findingType] : undefined;
  const sentence = template ? template(f) : null;
  const base = parts.join(' — ');
  if (base && sentence) return `${base}. ${sentence}`;
  return sentence ?? (base ? `${base}.` : '');
}
