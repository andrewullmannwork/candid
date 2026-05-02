/**
 * SBC "Other Covered Services" section — additional benefits list.
 *
 * Reuses the per-service extraction logic from common-medical-events.ts but with
 * "other_covered_services" sectionHint. Many SBCs list additional benefits here
 * (chiropractic, acupuncture, infertility, weight loss, etc.) that may have either
 * cost-sharing OR be listed without cost (depending on plan).
 *
 * Same STANDARD_SLUGS vocabulary; same Pattern P-8 emission.
 */

import type { ExtractionMethod } from "../../parser/types";
import type { SBCHaikuService, SBCSectionResult } from "../types";
import { extractCommonMedicalEvents } from "./common-medical-events";

export async function extractOtherCovered(
  sectionText: string,
  sectionRange: { start: number; end: number },
  extractionMethod: ExtractionMethod,
): Promise<SBCSectionResult<{ services: SBCHaikuService[] }>> {
  return extractCommonMedicalEvents(sectionText, sectionRange, extractionMethod, "other_covered_services");
}
