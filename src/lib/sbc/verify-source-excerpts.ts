/**
 * SBC-specific Pattern P-8 verifier orchestrator.
 *
 * Walks the SBCHaikuParseResult tree and verifies each Pattern P-8 provenance
 * entry via shared `verifyOne()` helper. Generic verification logic
 * (normalizeWhitespace, findContainingSection, two-pass match, DO_NOT_EXTRACT
 * relaxation, recall-maximize section semantics) lives in
 * `src/lib/parser/verify-source-excerpts.ts`.
 */

import type { SectionRanges } from "../parser/types";
import { verifyOne, type VerifyContext } from "../parser/verify-source-excerpts";
import type { SBCHaikuParseResult, SBCPatternP8Provenance } from "./types";

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
