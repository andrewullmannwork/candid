/**
 * Plan_doc Pattern P-8 verifier orchestrator.
 *
 * Walks the PlanDocHaikuParseResult tree and verifies each Pattern P-8 provenance
 * entry via shared `verifyOne()` helper. Generic verification logic
 * (normalizeWhitespace, findContainingSection, two-pass match, DO_NOT_EXTRACT
 * relaxation, recall-maximize section semantics) lives in
 * `src/lib/parser/verify-source-excerpts.ts`.
 *
 * Phase 4.0.5: post-pass derives `verbatim_absent` state when dispatchedSections
 * covers ALL non-DO_NOT_EXTRACT plan_doc sections AND verified === 'not_found' —
 * deterministic signal that the value is genuinely absent from this document.
 *
 * Mirrors `src/lib/sbc/verify-source-excerpts.ts:verifySBCSourceExcerpts()` pattern.
 */

import type { SectionRanges } from "../parser/types";
import { verifyOne, type VerifyContext } from "../parser/verify-source-excerpts";
import type {
  PlanDocHaikuParseResult,
  PlanDocPatternP8Provenance,
  PlanDocSectionHint,
} from "./types";

// Non-DO_NOT_EXTRACT plan_doc sections that get Haiku-dispatched. Per Q-P4.0.5-2 LOCK:
// `verbatim_absent` derives only when dispatchedSections covers ALL of these.
// "other" is the synthetic preamble — segmentation-only, never Haiku-dispatched —
// so excluded from the threshold.
const NON_DO_NOT_EXTRACT_PLAN_DOC_SECTIONS: PlanDocSectionHint[] = [
  "plan_identity",
  "services_cost_sharing",
  "access_instructions",
];

function coversAllNonDoNotExtract(
  dispatched: PlanDocSectionHint[] | undefined,
): boolean {
  if (!dispatched || dispatched.length === 0) return false;
  const set = new Set(dispatched);
  return NON_DO_NOT_EXTRACT_PLAN_DOC_SECTIONS.every((s) => set.has(s));
}

function deriveVerbatimAbsent(
  patternP8: PlanDocPatternP8Provenance,
  dispatched: PlanDocSectionHint[] | undefined,
): void {
  if (
    patternP8.source_excerpt_verified === "not_found" &&
    coversAllNonDoNotExtract(dispatched)
  ) {
    patternP8.source_excerpt_verified = "verbatim_absent";
  }
}

const PLAN_IDENTITY_FIELDS = [
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

export function verifyPlanDocSourceExcerpts(
  rawDocText: string,
  result: PlanDocHaikuParseResult,
  sectionRanges: SectionRanges,
): PlanDocHaikuParseResult {
  const ctx: VerifyContext = { normalizedRawDocText: null };
  const warnings: string[] = [...result.parseWarnings];

  // Deep copy to avoid mutating caller input (matches SBC verifier pattern).
  const planIdentity = JSON.parse(JSON.stringify(result.planIdentity)) as PlanDocHaikuParseResult["planIdentity"];
  const services = JSON.parse(JSON.stringify(result.services)) as PlanDocHaikuParseResult["services"];
  const accessInstructions = result.accessInstructions
    ? (JSON.parse(JSON.stringify(result.accessInstructions)) as NonNullable<
        PlanDocHaikuParseResult["accessInstructions"]
      >)
    : null;

  // Plan-level fields — verify each scalar's Pattern P-8
  for (const field of PLAN_IDENTITY_FIELDS) {
    const planField = planIdentity[field];
    if (planField?.patternP8) {
      const w = verifyOne(
        planField.patternP8,
        rawDocText,
        sectionRanges,
        `planIdentity.${field}`,
        ctx,
      );
      warnings.push(...w);
    }
  }

  // Per-service rows — single P-8 per service covers all cost-sharing fields
  services.forEach((svc, i) => {
    if (svc.patternP8) {
      const w = verifyOne(
        svc.patternP8,
        rawDocText,
        sectionRanges,
        `services[${i}]:${svc.serviceSlug}`,
        ctx,
      );
      warnings.push(...w);
    }
  });

  // Access instructions: customerServicePhone + networkFinderUrl + domainContacts
  if (accessInstructions) {
    if (accessInstructions.customerServicePhone?.patternP8) {
      const w = verifyOne(
        accessInstructions.customerServicePhone.patternP8,
        rawDocText,
        sectionRanges,
        "accessInstructions.customerServicePhone",
        ctx,
      );
      warnings.push(...w);
    }
    if (accessInstructions.networkFinderUrl?.patternP8) {
      const w = verifyOne(
        accessInstructions.networkFinderUrl.patternP8,
        rawDocText,
        sectionRanges,
        "accessInstructions.networkFinderUrl",
        ctx,
      );
      warnings.push(...w);
    }
    if (accessInstructions.domainContactsPatternP8) {
      const w = verifyOne(
        accessInstructions.domainContactsPatternP8,
        rawDocText,
        sectionRanges,
        "accessInstructions.domainContacts",
        ctx,
      );
      warnings.push(...w);
    }
  }

  // Phase 4.0.5: post-pass derives `verbatim_absent` for fields where verifier
  // emitted `not_found` AND the parser dispatched all non-DO_NOT_EXTRACT sections.
  // Per Q-P4.0.5-2 LOCK = (A) ALL non-DO_NOT_EXTRACT.
  const dispatched = result.dispatchedSections;
  for (const field of PLAN_IDENTITY_FIELDS) {
    const planField = planIdentity[field];
    if (planField?.patternP8) deriveVerbatimAbsent(planField.patternP8, dispatched);
  }
  services.forEach((svc) => {
    if (svc.patternP8) deriveVerbatimAbsent(svc.patternP8, dispatched);
  });
  if (accessInstructions) {
    if (accessInstructions.customerServicePhone?.patternP8) {
      deriveVerbatimAbsent(accessInstructions.customerServicePhone.patternP8, dispatched);
    }
    if (accessInstructions.networkFinderUrl?.patternP8) {
      deriveVerbatimAbsent(accessInstructions.networkFinderUrl.patternP8, dispatched);
    }
    if (accessInstructions.domainContactsPatternP8) {
      deriveVerbatimAbsent(accessInstructions.domainContactsPatternP8, dispatched);
    }
  }

  return {
    ...result,
    planIdentity,
    services,
    accessInstructions,
    parseWarnings: warnings,
  };
}
