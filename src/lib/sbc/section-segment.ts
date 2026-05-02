/**
 * SBC section segmentation per Phase 3.2 Subplan + Q-P3.2-3 LOCK (per-section dispatch).
 *
 * Detects the 5 standard SBC sections via regex anchored on section heading text.
 * SBCs follow a federal DOL/HHS template with relatively stable section headings,
 * so regex segmentation is reliable; Haiku discovery fallback (used in EOC) is NOT
 * needed here unless empirical data shows >5% segmentation miss rate.
 *
 * Returns SectionRanges (offset-based) for each detected section + synthetic
 * preamble "other" range for content before the first heading match (universal
 * pattern from Phase 3.1B.1 — every PDF has cover/header content before sections).
 */

import type { SectionRanges } from "../parser/types";
import type { SBCSectionHint } from "./types";

interface SectionPattern {
  hint: SBCSectionHint;
  patterns: RegExp[];
}

/**
 * Section heading vocabulary — universal across SBCs (federal template).
 * Each heading variant is observed in production fixtures (Ambetter / Blue Shield /
 * WHA across 2024-2026).
 *
 * Insurer-agnostic by construction. NEVER add insurer-specific phrasings here —
 * if a new vocabulary variant is observed, add the SEMANTIC name, not a brand name.
 */
const SECTION_PATTERNS: SectionPattern[] = [
  {
    hint: "important_questions",
    patterns: [
      // Federal SBC template heading. `\s+` accommodates pdftotext line splits
      // (e.g., "Important\nQuestions"). `\b` anchors after "Questions" to avoid
      // matching mid-word.
      /^\s*Important\s+Questions\b/im,
      /^\s*The\s+Important\s+Questions\b/im,
    ],
  },
  {
    hint: "common_medical_events",
    patterns: [
      // Universal pattern: federal template uses "Common Medical Events" (plural)
      // OR "Common Medical Event" (singular — observed in Ambetter SBCs). Also
      // handles pdftotext heading splits ("Common Medical\nEvent"). Anchor at
      // line start to avoid matching body-text references like "See the Common
      // Medical Events chart below" (observed in WHA SBC).
      /^\s*Common\s+Medical\b/im,
      /^\s*Common\s+Healthcare\b/im, // observed variant; includes "Healthcare Events"/"Healthcare Event"
    ],
  },
  {
    hint: "other_covered_services",
    patterns: [
      /^\s*Other\s+Covered\s+Services\b/im,
      /\bOther\s+Covered\s+Services\s*\(.*?Limitations\b/im, // "Other Covered Services (Limitations may apply…)"
    ],
  },
  {
    hint: "excluded_services",
    patterns: [
      /^\s*Excluded\s+Services\s*&\s*Other\s+Covered\s+Services\b/im,
      /^\s*Services\s+Your\s+Plan\s+Generally\s+Does\s+NOT\s+Cover\b/im,
      /^\s*Excluded\s+Services\b/im, // standalone fallback
    ],
  },
  {
    hint: "appeals_grievances",
    patterns: [
      /^\s*Your\s+Grievance\s+and\s+Appeals?\s+Rights\b/im,
      /^\s*Grievance\s+and\s+Appeals?\s+Rights\b/im,
      /^\s*Your\s+Rights?\s+to\s+Appeal\b/im,
    ],
  },
  {
    hint: "coverage_examples_DO_NOT_EXTRACT",
    patterns: [
      /^\s*About\s+These\s+Coverage\s+Examples\b/im,
      /^\s*Coverage\s+Examples\b/im,
    ],
  },
  {
    hint: "uniform_glossary_DO_NOT_EXTRACT",
    patterns: [
      /^\s*Uniform\s+Glossary\b/im,
      /^\s*GLOSSARY\b/im, // sometimes embedded in bundled SBC PDFs
    ],
  },
];

interface MatchPosition {
  hint: SBCSectionHint;
  index: number; // start offset of the heading
}

/**
 * Find all section heading positions in the raw doc text.
 * Returns sorted by document offset for sequential range computation.
 */
function findHeadingPositions(text: string): MatchPosition[] {
  const positions: MatchPosition[] = [];
  for (const { hint, patterns } of SECTION_PATTERNS) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) {
        positions.push({ hint, index: match.index });
        break; // one position per hint — sections don't repeat in a single SBC
      }
    }
  }
  return positions.sort((a, b) => a.index - b.index);
}

/**
 * Segment SBC raw doc text into sections per Pattern P-8 SectionRanges contract.
 *
 *   - Each detected section runs from its heading to the next heading (or doc end).
 *   - Preamble: synthetic "other" range from offset 0 to first heading (universal
 *     Phase 3.1B.1 pattern — every PDF has pre-section content).
 *   - If NO headings match: entire doc is one "other" range.
 */
export function segmentSBCSections(rawDocText: string): SectionRanges {
  const ranges: SectionRanges = {};
  const positions = findHeadingPositions(rawDocText);

  if (positions.length === 0) {
    // No headings detected — treat entire doc as 'other'
    if (rawDocText.length > 0) {
      ranges.other = [{ start: 0, end: rawDocText.length }];
    }
    return ranges;
  }

  // Preamble (synthetic "other" range before first heading)
  if (positions[0].index > 0) {
    ranges.other = [{ start: 0, end: positions[0].index }];
  }

  // Each section runs from its heading to the next heading (or doc end)
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : rawDocText.length;
    const hint = positions[i].hint;
    if (!ranges[hint]) {
      ranges[hint] = [];
    }
    ranges[hint].push({ start, end });
  }

  return ranges;
}

/**
 * Count how many of the 5 priority extraction sections were detected.
 * Drives empirical segmentation-quality watch metric (target: ≥4 of 5 per fixture).
 */
export function countPrioritySBCSections(ranges: SectionRanges): number {
  const priority: SBCSectionHint[] = [
    "important_questions",
    "common_medical_events",
    "other_covered_services",
    "excluded_services",
    "appeals_grievances",
  ];
  return priority.filter((hint) => ranges[hint]?.length).length;
}

/**
 * Return the full text of a section, or null if not detected.
 * Convenience wrapper for parser orchestrator.
 */
export function sliceSection(
  rawDocText: string,
  ranges: SectionRanges,
  hint: SBCSectionHint,
): string | null {
  const arr = ranges[hint];
  if (!arr || arr.length === 0) return null;
  const { start, end } = arr[0];
  return rawDocText.slice(start, end);
}
