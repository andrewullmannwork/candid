/**
 * SBC-specific Pattern P-8 verifier orchestrator.
 *
 * Walks the SBCHaikuParseResult tree and verifies each Pattern P-8 provenance
 * entry via shared `verifyOne()` helper. Generic verification logic
 * (normalizeWhitespace, findContainingSection, two-pass match, DO_NOT_EXTRACT
 * relaxation, recall-maximize section semantics) lives in
 * `src/lib/parser/verify-source-excerpts.ts`.
 *
 * Phase 4.0.5: post-pass derives `verbatim_absent` state when dispatchedSections
 * covers ALL non-DO_NOT_EXTRACT SBC sections AND verified === 'not_found' —
 * deterministic signal that the value is genuinely absent from this document
 * (vs `not_found` which could mean parser missed during search).
 */

import type { SectionRanges } from "../parser/types";
import { verifyOne, type VerifyContext } from "../parser/verify-source-excerpts";
import type { SBCHaikuParseResult, SBCPatternP8Provenance, SBCSectionHint } from "./types";

// Non-DO_NOT_EXTRACT SBC sections that get Haiku-dispatched. Per Q-P4.0.5-2 LOCK:
// `verbatim_absent` derives only when dispatchedSections covers ALL of these.
// "other" is the synthetic preamble — segmentation-only, never Haiku-dispatched —
// so excluded from the threshold.
const NON_DO_NOT_EXTRACT_SBC_SECTIONS: SBCSectionHint[] = [
  "important_questions",
  "common_medical_events",
  "other_covered_services",
  "excluded_services",
  "appeals_grievances",
];

function coversAllNonDoNotExtract(dispatched: SBCSectionHint[] | undefined): boolean {
  if (!dispatched || dispatched.length === 0) return false;
  const set = new Set(dispatched);
  return NON_DO_NOT_EXTRACT_SBC_SECTIONS.every((s) => set.has(s));
}

function deriveVerbatimAbsent(
  patternP8: SBCPatternP8Provenance,
  dispatched: SBCSectionHint[] | undefined,
): void {
  if (
    patternP8.source_excerpt_verified === "not_found" &&
    coversAllNonDoNotExtract(dispatched)
  ) {
    patternP8.source_excerpt_verified = "verbatim_absent";
  }
}

export function verifySBCSourceExcerpts(
  rawDocText: string,
  result: SBCHaikuParseResult,
  sectionRanges: SectionRanges,
): SBCHaikuParseResult {
  const ctx: VerifyContext = { normalizedRawDocText: null };
  const warnings: string[] = [...result.parseWarnings];

  // Deep copy to avoid mutating caller input
  const planIdentity = JSON.parse(JSON.stringify(result.planIdentity)) as SBCHaikuParseResult["planIdentity"];
  const services = JSON.parse(JSON.stringify(result.services)) as SBCHaikuParseResult["services"];
  const otherCoveredServices = JSON.parse(
    JSON.stringify(result.otherCoveredServices),
  ) as SBCHaikuParseResult["otherCoveredServices"];
  const appealsContacts = JSON.parse(JSON.stringify(result.appealsContacts)) as SBCHaikuParseResult["appealsContacts"];
  const excludedServicesPatternP8 = result.excludedServicesPatternP8
    ? (JSON.parse(JSON.stringify(result.excludedServicesPatternP8)) as SBCPatternP8Provenance)
    : null;

  // Plan-level fields — verify each scalar's Pattern P-8
  // CF-19c (Session 64): OON deductible/OOP fields added — they get the same
  // Pattern P-8 verifier path as in-network values.
  const planFields = [
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

  for (const field of planFields) {
    const planField = planIdentity[field];
    if (planField?.patternP8) {
      const w = verifyOne(planField.patternP8, rawDocText, sectionRanges, `planIdentity.${field}`, ctx);
      warnings.push(...w);
    }
  }

  // Common medical events services
  services.forEach((svc, i) => {
    if (svc.patternP8) {
      const w = verifyOne(svc.patternP8, rawDocText, sectionRanges, `services[${i}]:${svc.serviceSlug}`, ctx);
      warnings.push(...w);
    }
  });

  // Other covered services
  otherCoveredServices.forEach((svc, i) => {
    if (svc.patternP8) {
      const w = verifyOne(
        svc.patternP8,
        rawDocText,
        sectionRanges,
        `otherCoveredServices[${i}]:${svc.serviceSlug}`,
        ctx,
      );
      warnings.push(...w);
    }
  });

  // Excluded services list (single P-8 for the whole list)
  if (excludedServicesPatternP8) {
    const w = verifyOne(excludedServicesPatternP8, rawDocText, sectionRanges, "excludedServices", ctx);
    warnings.push(...w);
  }

  // Appeals contacts
  appealsContacts.forEach((contact, i) => {
    if (contact.patternP8) {
      const label = contact.category ? `appealsContacts[${i}]:${contact.category}` : `appealsContacts[${i}]`;
      const w = verifyOne(contact.patternP8, rawDocText, sectionRanges, label, ctx);
      warnings.push(...w);
    }
  });

  // Phase 4.0.5: post-pass derives `verbatim_absent` for fields where verifier
  // emitted `not_found` AND the parser dispatched all non-DO_NOT_EXTRACT sections.
  // Per Q-P4.0.5-2 LOCK = (A) ALL non-DO_NOT_EXTRACT.
  const dispatched = result.dispatchedSections;
  for (const field of planFields) {
    const planField = planIdentity[field];
    if (planField?.patternP8) deriveVerbatimAbsent(planField.patternP8, dispatched);
  }
  services.forEach((svc) => {
    if (svc.patternP8) deriveVerbatimAbsent(svc.patternP8, dispatched);
  });
  otherCoveredServices.forEach((svc) => {
    if (svc.patternP8) deriveVerbatimAbsent(svc.patternP8, dispatched);
  });
  if (excludedServicesPatternP8) deriveVerbatimAbsent(excludedServicesPatternP8, dispatched);
  appealsContacts.forEach((contact) => {
    if (contact.patternP8) deriveVerbatimAbsent(contact.patternP8, dispatched);
  });

  return {
    ...result,
    planIdentity,
    services,
    otherCoveredServices,
    appealsContacts,
    excludedServicesPatternP8,
    parseWarnings: warnings,
  };
}
