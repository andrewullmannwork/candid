/**
 * Verbatim self-check loop for plan_doc Pattern P-8 source_excerpt fields per
 * Phase 3.1A.1 mechanism inheritance (S73 — Session 76).
 *
 * Iteration-2 contingency. Fires when env var `PLAN_DOC_SELF_CHECK_ENABLED=true`.
 *
 * Flow (mirrors `src/lib/eoc/self-check.ts`):
 *   1. Walk PlanDocHaikuParseResult tree; find fields with source_excerpt_verified='not_found'
 *      AND non-empty source_excerpt (Haiku tried; verifier rejected).
 *   2. For each: re-prompt Haiku with the section text + failed excerpt + corrective
 *      instruction. Haiku returns either a corrected verbatim substring OR empty
 *      ("cannot quote verbatim").
 *   3. Replace source_excerpt with corrected value. Caller re-runs verifier to
 *      refresh source_excerpt_verified + source_section_verified.
 *
 * Section selection: uses field's source_section_hint to slice the relevant section.
 * Multi-section dispatch (S73) means a planIdentity field's hint may be e.g.
 * "services_cost_sharing" rather than "plan_identity" — self-check honors the actual
 * section Haiku extracted from. For "other" preamble, slices the preamble range.
 *
 * Cost containment: only fires on verifier failures; each call is small (~500-2000
 * input tokens + tiny output). Estimated +$0.05-0.15/plan_doc when many fields fail.
 *
 * NO new feature flag, NO new migration — env var only during iteration; production
 * default state hardcoded at session close per DR-3.1A.1-B-4 pattern.
 */

import { callHaikuWithCache } from "./haiku-prompts/_shared";
import type { SectionRanges } from "../parser/types";
import type {
  PlanDocHaikuParseResult,
  PlanDocPatternP8Provenance,
  PlanDocSectionHint,
} from "./types";

const SELF_CHECK_SYSTEM_PROMPT = `You are correcting a source_excerpt that failed verbatim verification. The previously-emitted excerpt is NOT a character-for-character substring of the source text. Either:
  (a) Emit a CORRECTED verbatim ≤200-char substring that appears EXACTLY in the source text below.
  (b) Confirm you cannot quote verbatim by returning empty string "".

Return ONLY this JSON object (no preamble, no markdown fences):
{
  "corrected_excerpt": "<verbatim substring OR empty string>",
  "haiku_confidence": <0.0-1.0>
}`;

interface SelfCheckResponse {
  corrected_excerpt?: string;
  haiku_confidence?: number;
}

interface OneCheckResult {
  corrected: string;
  confidence: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  warnings: string[];
}

async function selfCheckOne(failedExcerpt: string, sectionText: string): Promise<OneCheckResult> {
  const userContent = `Failed excerpt:\n"${failedExcerpt}"\n\nSource text section:\n${sectionText}`;
  const result = await callHaikuWithCache<SelfCheckResponse>({
    systemPrompt: SELF_CHECK_SYSTEM_PROMPT,
    userContent,
    sectionLabel: "self_check",
  });
  return {
    corrected: typeof result.data.corrected_excerpt === "string" ? result.data.corrected_excerpt.slice(0, 200) : "",
    confidence: typeof result.data.haiku_confidence === "number" ? result.data.haiku_confidence : 0,
    cost: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    warnings: result.warnings,
  };
}

export interface SelfCheckSummary {
  warnings: string[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  attemptedCount: number;
  recoveredCount: number;
  confirmedEmptyCount: number;
  stillFailedCount: number;
}

export function isSelfCheckEnabled(): boolean {
  return process.env.PLAN_DOC_SELF_CHECK_ENABLED === "true";
}

/**
 * Slice the section text indicated by source_section_hint. Returns null if section
 * not in sectionRanges (e.g., field's source_section_hint claims "plan_identity" but
 * segmentation found nothing for that section — verifier already flagged as not_found
 * via "no real section" path).
 *
 * Falls back to full working text when sectionHint references a section absent from
 * ranges (defensive — should rarely fire in practice).
 */
function getSectionText(
  rawDocText: string,
  sectionRanges: SectionRanges,
  hint: PlanDocSectionHint,
): string | null {
  const ranges = sectionRanges[hint];
  if (!ranges || ranges.length === 0) return null;
  const r = ranges[0];
  return rawDocText.slice(r.start, r.end);
}

/**
 * Walk the verified PlanDocHaikuParseResult tree and self-check each 'not_found' excerpt.
 * Mutates the result in-place with corrected excerpts; caller re-runs verifier
 * (verifyPlanDocSourceExcerpts) to refresh verified flags.
 *
 * Self-checks dispatched via a worker-pool semaphore with CONCURRENCY=3 to respect
 * Anthropic API tier rate limits (~5 concurrent / ~50 RPM). Earlier unbounded
 * Promise.allSettled approach fired 100+ simultaneous calls on high-failure fixtures
 * → most hit 429 rate-limit responses + SDK auto-retry exponential backoff → run
 * stalled for hours. Concurrency=3 saturates throughput without exceeding limit.
 * Each call is independent; no shared state. Cost-cap enforcement left to caller.
 */

const SELF_CHECK_CONCURRENCY = 3;

/**
 * Process items with bounded concurrency. Worker pool drains a shared queue;
 * at most `concurrency` tasks run simultaneously. Returns results in input order.
 *
 * Generic helper — could move to src/lib/parser/concurrency.ts if other parsers
 * need it. Local to self-check for now (S73 Session 76 scope).
 */
async function processWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function selfCheckPlanDocExcerpts(
  preliminaryResult: PlanDocHaikuParseResult,
  rawDocText: string,
  sectionRanges: SectionRanges,
): Promise<{ updatedResult: PlanDocHaikuParseResult; summary: SelfCheckSummary }> {
  const summary: SelfCheckSummary = {
    warnings: [],
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    attemptedCount: 0,
    recoveredCount: 0,
    confirmedEmptyCount: 0,
    stillFailedCount: 0,
  };

  // Deep clone to avoid mutating caller input
  const planIdentity = JSON.parse(
    JSON.stringify(preliminaryResult.planIdentity),
  ) as PlanDocHaikuParseResult["planIdentity"];
  const services = JSON.parse(
    JSON.stringify(preliminaryResult.services),
  ) as PlanDocHaikuParseResult["services"];
  const accessInstructions = preliminaryResult.accessInstructions
    ? (JSON.parse(JSON.stringify(preliminaryResult.accessInstructions)) as NonNullable<
        PlanDocHaikuParseResult["accessInstructions"]
      >)
    : null;

  // Collect all P-8 items to check; key by `field path`
  interface CheckTarget {
    fieldPath: string;
    patternP8: PlanDocPatternP8Provenance;
  }
  const targets: CheckTarget[] = [];

  const PLAN_IDENTITY_KEYS = [
    "planName",
    "insurerName",
    "planType",
    "metalTier",
    "planYear",
    "groupNumber",
    "networkType",
    "deductibleIndividual",
    "deductibleFamily",
    "oopMaxIndividual",
    "oopMaxFamily",
    "outDeductibleIndividual",
    "outDeductibleFamily",
    "outOopMaxIndividual",
    "outOopMaxFamily",
  ] as const;

  for (const key of PLAN_IDENTITY_KEYS) {
    const field = planIdentity[key];
    if (field?.patternP8) {
      targets.push({
        fieldPath: `planIdentity.${key}`,
        patternP8: field.patternP8,
      });
    }
  }

  services.forEach((svc, i) => {
    if (svc.patternP8) {
      targets.push({
        fieldPath: `services[${i}]:${svc.serviceSlug}`,
        patternP8: svc.patternP8,
      });
    }
  });

  if (accessInstructions) {
    if (accessInstructions.customerServicePhone?.patternP8) {
      targets.push({
        fieldPath: "accessInstructions.customerServicePhone",
        patternP8: accessInstructions.customerServicePhone.patternP8,
      });
    }
    if (accessInstructions.networkFinderUrl?.patternP8) {
      targets.push({
        fieldPath: "accessInstructions.networkFinderUrl",
        patternP8: accessInstructions.networkFinderUrl.patternP8,
      });
    }
    if (accessInstructions.domainContactsPatternP8) {
      targets.push({
        fieldPath: "accessInstructions.domainContacts",
        patternP8: accessInstructions.domainContactsPatternP8,
      });
    }
  }

  // Filter to actual self-check candidates (not_found + non-empty excerpt)
  const candidates = targets.filter(
    (t) =>
      t.patternP8.source_excerpt_verified === "not_found" &&
      t.patternP8.source_excerpt &&
      t.patternP8.source_excerpt.length > 0,
  );

  // Dispatch self-checks via bounded worker pool (CONCURRENCY=3) to respect Anthropic
  // rate limits. Each Haiku call is independent.
  type SelfCheckOutcome =
    | { target: CheckTarget; outcome: "no_section_text" }
    | { target: CheckTarget; sc: OneCheckResult; outcome: "checked" }
    | { target: CheckTarget; outcome: "error"; errorMessage: string };

  const results = await processWithConcurrency<CheckTarget, SelfCheckOutcome>(
    candidates,
    SELF_CHECK_CONCURRENCY,
    async (target): Promise<SelfCheckOutcome> => {
      summary.attemptedCount++;
      const sectionText = getSectionText(rawDocText, sectionRanges, target.patternP8.source_section_hint);
      if (!sectionText) {
        return { target, outcome: "no_section_text" };
      }
      try {
        const sc = await selfCheckOne(target.patternP8.source_excerpt, sectionText);
        return { target, sc, outcome: "checked" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { target, outcome: "error", errorMessage: msg };
      }
    },
  );

  // Apply corrections sequentially (mutates patternP8 in place)
  for (const r of results) {
    const { target } = r;
    if (r.outcome === "no_section_text") {
      summary.warnings.push(`self_check_no_section_text:${target.fieldPath}:${target.patternP8.source_section_hint}`);
      summary.stillFailedCount++;
      continue;
    }
    if (r.outcome === "error") {
      summary.warnings.push(`self_check_error:${target.fieldPath}:${r.errorMessage}`);
      summary.stillFailedCount++;
      continue;
    }
    // outcome === "checked" (narrowed via discriminated union above)
    const sc = r.sc;
    summary.totalCostUsd += sc.cost;
    summary.totalInputTokens += sc.inputTokens;
    summary.totalOutputTokens += sc.outputTokens;
    summary.warnings.push(...sc.warnings);

    if (sc.corrected === "") {
      target.patternP8.source_excerpt = "";
      summary.warnings.push(`self_check_confirmed_empty:${target.fieldPath}`);
      summary.confirmedEmptyCount++;
    } else if (rawDocText.includes(sc.corrected)) {
      target.patternP8.source_excerpt = sc.corrected;
      summary.warnings.push(`self_check_recovered:${target.fieldPath}`);
      summary.recoveredCount++;
    } else {
      summary.warnings.push(`self_check_still_failed:${target.fieldPath}`);
      summary.stillFailedCount++;
    }
  }

  const updatedResult: PlanDocHaikuParseResult = {
    ...preliminaryResult,
    planIdentity,
    services,
    accessInstructions,
    parseWarnings: [...preliminaryResult.parseWarnings, ...summary.warnings],
    costUsd: preliminaryResult.costUsd + summary.totalCostUsd,
    haikuTokensInput: preliminaryResult.haikuTokensInput + summary.totalInputTokens,
    haikuTokensOutput: preliminaryResult.haikuTokensOutput + summary.totalOutputTokens,
  };

  return { updatedResult, summary };
}
