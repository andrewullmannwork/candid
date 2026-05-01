/**
 * Pattern P-8 consumer-facing formatter for `source_section_hint` enum values.
 *
 * Phase 4+ consumers (dispute-letter "show me the receipts" UI, regulatory
 * data-subject-access requests, audit display) use this function to render a
 * human-readable section name regardless of which parser produced the hint.
 *
 * Layering note: parser-internal code uses parser-specific enums (e.g.,
 * `EOBSectionHint` in `eob-postprocess.ts`). Consumers use the opaque string
 * stored in JSONB and call this formatter — they do NOT import parser-specific
 * types directly, which would couple Phase 4 to parser internals.
 *
 * Adding a new section hint: extend the switch below. Unknown hints fall through
 * to "Unknown section" — silent typos in writers surface visibly to readers.
 */

import { DO_NOT_EXTRACT_SUFFIX } from "./types";

export function formatSectionHint(hint: string | undefined | null): string {
  if (!hint) return "Unknown section";

  switch (hint) {
    // EOB sections
    case "claim_header":
      return "Claim Header";
    case "line_items_table":
      return "Line Items Table";
    case "denial_codes_section":
      return "Denial Codes / Reason Codes";
    case "accumulator_block":
      return "Accumulator (Deductible / Out-of-Pocket)";
    case "appeal_rights_DO_NOT_EXTRACT":
      return "Appeal Rights (boilerplate — should not be extracted)";
    case "glossary_DO_NOT_EXTRACT":
      return "Glossary (boilerplate — should not be extracted)";
    case "footer_legalese_DO_NOT_EXTRACT":
      return "Footer Legalese (boilerplate — should not be extracted)";
    case "other":
      return "Other";

    // Future SBC / EOC / formulary section hints land here as parsers ship.
    default:
      // Generic fallback: gently format any *_DO_NOT_EXTRACT-suffixed hint, since the
      // suffix convention is universal. Other unknowns surface as "Unknown section"
      // to make writer-side typos visible.
      if (hint.endsWith(DO_NOT_EXTRACT_SUFFIX)) {
        const base = hint.slice(0, -DO_NOT_EXTRACT_SUFFIX.length).replace(/_/g, " ");
        return `${base} (boilerplate — should not be extracted)`;
      }
      return "Unknown section";
  }
}
