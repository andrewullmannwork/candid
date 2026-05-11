/**
 * Verbatim self-check loop for SBC Pattern P-8 source_excerpt fields per
 * Phase 3.1A.1 mechanism inheritance (S77 — Session 77 architectural carve-out).
 *
 * Iteration-2 contingency. Fires when env var `SBC_SELF_CHECK_ENABLED=true`.
 *
 * Per-parser self-check policy (Session 77 codification):
 *   - SBC parser: self-check ON in PROD — multi-column tabular SBC layouts produce
 *     pdftotext column-wrap garbling; first-pass Haiku extracts values correctly but
 *     verbatim verification fails on column-mangled spans. Self-check recovers
 *     ~20-25pts of services cite-grade (Kaiser Gold 80 empirical: 74.5% → 97.9%).
 *   - EOC parser: self-check ON in PROD — column-heavy cost-sharing tables exhibit
 *     similar column-wrap recovery benefits (Phase 3.1A.1 Session 52 empirical:
 *     EOC services cite-grade 20% → 97.6% with self-check).
 *   - plan_doc parser: self-check OFF in PROD — real plan documents (employer
 *     benefits booklets) have narrative cost-sharing text where first-pass cite-grade
 *     succeeds without recovery (Cigna PB Session 77 empirical: 99.5% services
 *     cite-grade WITHOUT self-check vs 96.0% WITH; recovery loop adds noise + cost).
 *
 * Flow (mirrors `src/lib/plan_doc/self-check.ts`):
 *   1. Walk SBCHaikuParseResult tree; find fields with source_excerpt_verified='not_found'
 *      AND non-empty source_excerpt (Haiku tried; verifier rejected).
 *   2. For each: re-prompt Haiku with the section text + failed excerpt + corrective
 *      instruction. Haiku returns either a corrected verbatim substring OR empty
 *      ("cannot quote verbatim").
 *   3. Replace source_excerpt with corrected value. Caller re-runs verifier to
 *      refresh source_excerpt_verified + source_section_verified.
 *
 * Section selection: uses field's source_section_hint to slice the relevant section.
 * For section hints absent from ranges (rare), returns null and field is left as-is
 * (logged as `self_check_no_section_text`).
 *
 * Concurrency: bounded worker pool (CONCURRENCY=3) respects Anthropic tier rate
 * limits (~5 concurrent / ~50 RPM). Unbounded parallel calls produced 429 storms
 * + SDK retry backoff in earlier iterations.
 */

import { callHaikuWithCache } from "../haiku-client/base";
import type { SectionRanges } from "../parser/types";
import type {
  SBCHaikuParseResult,
  SBCPatternP8Provenance,
  SBCSectionHint,
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

export interface SBCSelfCheckSummary {
  warnings: string[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  attemptedCount: number;
  recoveredCount: number;
  confirmedEmptyCount: number;
  stillFailedCount: number;
}

export function isSBCSelfCheckEnabled(): boolean {
  return process.env.SBC_SELF_CHECK_ENABLED === "true";
}

function getSectionText(
  rawDocText: string,
  sectionRanges: SectionRanges,
  hint: SBCSectionHint,
): string | null {
  const ranges = sectionRanges[hint];
  if (!ranges || ranges.length === 0) return null;
  const r = ranges[0];
  return rawDocText.slice(r.start, r.end);
}

const SELF_CHECK_CONCURRENCY = 3;

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

/**
 * Walk the verified SBCHaikuParseResult tree and self-check each 'not_found' excerpt.
 * Mutates a deep-cloned copy with corrected excerpts; caller re-runs verifier
 * (verifySBCSourceExcerpts) to refresh verified flags.
 */
export async function selfCheckSBCExcerpts(
  preliminaryResult: SBCHaikuParseResult,
  rawDocText: string,
  sectionRanges: SectionRanges,
): Promise<{ updatedResult: SBCHaikuParseResult; summary: SBCSelfCheckSummary }> {
  const summary: SBCSelfCheckSummary = {
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
  ) as SBCHaikuParseResult["planIdentity"];
  const services = JSON.parse(
    JSON.stringify(preliminaryResult.services),
  ) as SBCHaikuParseResult["services"];
  const otherCoveredServices = JSON.parse(
    JSON.stringify(preliminaryResult.otherCoveredServices),
  ) as SBCHaikuParseResult["otherCoveredServices"];
  const appealsContacts = JSON.parse(
    JSON.stringify(preliminaryResult.appealsContacts),
  ) as SBCHaikuParseResult["appealsContacts"];
  let excludedServicesPatternP8 = preliminaryResult.excludedServicesPatternP8
    ? (JSON.parse(JSON.stringify(preliminaryResult.excludedServicesPatternP8)) as SBCPatternP8Provenance)
    : null;

  interface CheckTarget {
    fieldPath: string;
    patternP8: SBCPatternP8Provenance;
  }
  const targets: CheckTarget[] = [];

  // 20 plan-identity fields (per SBCPlanIdentity in types.ts)
  const PLAN_IDENTITY_KEYS = [
    "planName",
    "insurerName",
    "planType",
    "metalTier",
    "coverageTier",
    "planYear",
    "coveragePeriodStart",
    "deductibleIndividual",
    "deductibleFamily",
    "oopMaxIndividual",
    "oopMaxFamily",
    "outDeductibleIndividual",
    "outDeductibleFamily",
    "outOopMaxIndividual",
    "outOopMaxFamily",
    "rxDeductibleIndividual",
    "rxDeductibleFamily",
    "referralRequired",
    "minimumValueStandard",
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

  // services + otherCoveredServices (same shape; each has patternP8)
  services.forEach((svc, i) => {
    if (svc.patternP8) {
      targets.push({
        fieldPath: `services[${i}]:${svc.serviceSlug ?? "unknown"}`,
        patternP8: svc.patternP8,
      });
    }
  });
  otherCoveredServices.forEach((svc, i) => {
    if (svc.patternP8) {
      targets.push({
        fieldPath: `otherCoveredServices[${i}]:${svc.serviceSlug ?? "unknown"}`,
        patternP8: svc.patternP8,
      });
    }
  });

  // appealsContacts (multi-grievance-category SBCs)
  appealsContacts.forEach((contact, i) => {
    if (contact.patternP8) {
      targets.push({
        fieldPath: `appealsContacts[${i}]${contact.category ? `:${contact.category}` : ""}`,
        patternP8: contact.patternP8,
      });
    }
  });

  // excluded services (single patternP8 for the whole list)
  if (excludedServicesPatternP8) {
    targets.push({
      fieldPath: "excludedServices",
      patternP8: excludedServicesPatternP8,
    });
  }

  // Filter to actual self-check candidates (not_found + non-empty excerpt)
  const candidates = targets.filter(
    (t) =>
      t.patternP8.source_excerpt_verified === "not_found" &&
      t.patternP8.source_excerpt &&
      t.patternP8.source_excerpt.length > 0,
  );

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
      summary.warnings.push(`sbc_self_check_no_section_text:${target.fieldPath}:${target.patternP8.source_section_hint}`);
      summary.stillFailedCount++;
      continue;
    }
    if (r.outcome === "error") {
      summary.warnings.push(`sbc_self_check_error:${target.fieldPath}:${r.errorMessage}`);
      summary.stillFailedCount++;
      continue;
    }
    const sc = r.sc;
    summary.totalCostUsd += sc.cost;
    summary.totalInputTokens += sc.inputTokens;
    summary.totalOutputTokens += sc.outputTokens;
    summary.warnings.push(...sc.warnings);

    if (sc.corrected === "") {
      target.patternP8.source_excerpt = "";
      summary.warnings.push(`sbc_self_check_confirmed_empty:${target.fieldPath}`);
      summary.confirmedEmptyCount++;
    } else if (rawDocText.includes(sc.corrected)) {
      target.patternP8.source_excerpt = sc.corrected;
      summary.warnings.push(`sbc_self_check_recovered:${target.fieldPath}`);
      summary.recoveredCount++;
    } else {
      summary.warnings.push(`sbc_self_check_still_failed:${target.fieldPath}`);
      summary.stillFailedCount++;
    }
  }

  // If excludedServicesPatternP8 was modified in the loop above (via reference),
  // assign back. (Loop mutates targets[i].patternP8 which is the same object.)
  excludedServicesPatternP8 = excludedServicesPatternP8;

  const updatedResult: SBCHaikuParseResult = {
    ...preliminaryResult,
    planIdentity,
    services,
    otherCoveredServices,
    appealsContacts,
    excludedServicesPatternP8,
    parseWarnings: [...preliminaryResult.parseWarnings, ...summary.warnings],
    costUsd: preliminaryResult.costUsd + summary.totalCostUsd,
    haikuTokensInput: preliminaryResult.haikuTokensInput + summary.totalInputTokens,
    haikuTokensOutput: preliminaryResult.haikuTokensOutput + summary.totalOutputTokens,
  };

  return { updatedResult, summary };
}
