/**
 * Plan_doc section segmentation per S72 Subplan + Phase 3.1A architectural template.
 *
 * Detects 3 priority plan_doc sections via regex anchored on common heading text.
 * Plan documents vary widely (5-300 pages; insurer-published booklets / certificates
 * of coverage / employer-published guides), so regex segmentation is less reliable
 * than SBC (federal template) or EOC (relatively stable structure). Haiku-discovery
 * fallback (per EOC Phase 3.1A Q-P3.1A-4 pattern) fires when regex finds <2 priority
 * sections.
 *
 * Returns SectionRanges (offset-based) for each detected section + synthetic preamble
 * "other" range for content before the first heading match (universal pattern from
 * Phase 3.1B.1 — every PDF has cover/header content before sections).
 *
 * Insurer-agnostic by construction. NEVER add insurer-specific phrasings here — if a
 * new vocabulary variant is observed, add the SEMANTIC name, not a brand name.
 */

import type { SectionRanges } from "../parser/types";
import type { PlanDocSectionHint } from "./types";

interface SectionPattern {
  hint: PlanDocSectionHint;
  patterns: RegExp[];
}

const PRIORITY_SECTIONS: PlanDocSectionHint[] = [
  "plan_identity",
  "services_cost_sharing",
  "access_instructions",
];

/**
 * Section heading vocabulary — universal across plan documents (insurer-agnostic).
 * Each heading variant SHOULD be observed in production fixtures before being added.
 *
 * Plan-identity section: typically appears at the start as "Plan Information",
 * "Plan Summary", "Schedule of Benefits", or similar.
 *
 * Services + cost-sharing section: typically appears as "Schedule of Benefits",
 * "Covered Services", "Benefits Summary", or similar — often a long table.
 *
 * Access-instructions section: typically appears near the end as "Member Services",
 * "Customer Service", "How to Access Care", or "Contact Information".
 */
const SECTION_PATTERNS: SectionPattern[] = [
  {
    hint: "plan_identity",
    patterns: [
      /^\s*Plan\s+Information\b/im,
      /^\s*Plan\s+Summary\b/im,
      /^\s*Coverage\s+Information\b/im,
      /^\s*Plan\s+Identification\b/im,
    ],
  },
  {
    hint: "services_cost_sharing",
    patterns: [
      /^\s*Schedule\s+of\s+Benefits\b/im,
      /^\s*Covered\s+Services\b/im,
      /^\s*Benefits\s+Summary\b/im,
      /^\s*Cost[-\s]Sharing\s+Details\b/im,
      /^\s*Schedule\s+of\s+Medical\s+Benefits\b/im,
      /^\s*Medical\s+Benefits\s+Schedule\b/im,
    ],
  },
  {
    hint: "access_instructions",
    patterns: [
      /^\s*How\s+to\s+Access\s+Care\b/im,
      /^\s*Member\s+Services\b/im,
      /^\s*Customer\s+Service\b/im,
      /^\s*Contact\s+Information\b/im,
      /^\s*Accessing\s+Your\s+Benefits\b/im,
    ],
  },
  {
    hint: "header_DO_NOT_EXTRACT",
    patterns: [/^\s*(Cover\s+Page|Welcome\s+to|Important\s+Notice)\b/im],
  },
  {
    hint: "footer_legalese_DO_NOT_EXTRACT",
    patterns: [/^\s*(Legal\s+Notice|Disclaimer|Notice\s+of\s+Non-Discrimination)\b/im],
  },
  {
    hint: "glossary_DO_NOT_EXTRACT",
    patterns: [
      /^\s*Glossary\b/im,
      /^\s*Definitions\s+of\s+Common\s+Terms\b/im,
    ],
  },
];

interface HeadingMatch {
  hint: PlanDocSectionHint;
  start: number;
}

function findAllHeadings(text: string): HeadingMatch[] {
  const matches: HeadingMatch[] = [];
  for (const { hint, patterns } of SECTION_PATTERNS) {
    for (const pattern of patterns) {
      const m = pattern.exec(text);
      if (m && typeof m.index === "number") {
        matches.push({ hint, start: m.index });
        break; // first variant per hint wins
      }
    }
  }
  // Sort by char offset ascending so we can compute section ends as next-match's start.
  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Build SectionRanges from heading matches. Each heading's end is the next heading's
 * start (or end-of-text for the last heading).
 *
 * Synthetic preamble "other" range for content before the first heading
 * (Phase 3.1B.1 universal preamble pattern).
 */
export function segmentPlanDocSections(text: string): SectionRanges {
  const headings = findAllHeadings(text);
  const ranges: SectionRanges = {};

  const firstHeadingStart = headings.length > 0 ? headings[0].start : text.length;
  if (firstHeadingStart > 0) {
    ranges.other = [{ start: 0, end: firstHeadingStart }];
  }

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];
    const end = next?.start ?? text.length;
    if (!ranges[h.hint]) ranges[h.hint] = [];
    ranges[h.hint].push({ start: h.start, end });
  }

  return ranges;
}

/**
 * Count priority sections detected (excludes DO_NOT_EXTRACT + "other").
 */
export function countPriorityPlanDocSections(ranges: SectionRanges): number {
  return PRIORITY_SECTIONS.filter((s) => (ranges[s]?.length ?? 0) > 0).length;
}

/**
 * Slice a section's text from raw OCR text given a SectionRanges entry.
 */
export function sliceSection(
  text: string,
  ranges: SectionRanges,
  hint: PlanDocSectionHint,
): string | null {
  const range = ranges[hint]?.[0];
  if (!range) return null;
  return text.slice(range.start, range.end);
}

/**
 * Haiku-discovery fallback per Phase 3.1A Q-P3.1A-4 LOCK pattern. Fires when regex
 * finds <2 priority sections.
 *
 * MVP commit-2 scaffolding: stub-returns empty SectionRanges so the orchestrator's
 * regex+fallback control flow is exercised but Haiku-discovery is no-op until S73
 * (Phase 3.1A.1 verbatim quality lift) ships the full implementation per EOC pattern.
 */
export async function discoverPlanDocSectionsViaHaiku(text: string): Promise<SectionRanges> {
  // S73 deferred: full Haiku-discovery implementation per Phase 3.1A pattern.
  void text;
  return {};
}

/**
 * Merge two SectionRanges objects. Used to combine regex-detected ranges with
 * Haiku-discovered ranges per Phase 3.1A merge pattern.
 */
export function mergeSegmentations(a: SectionRanges, b: SectionRanges): SectionRanges {
  const merged: SectionRanges = { ...a };
  for (const key of Object.keys(b)) {
    const aRanges = merged[key] ?? [];
    const bRanges = b[key] ?? [];
    merged[key] = [...aRanges, ...bRanges].sort((x, y) => x.start - y.start);
  }
  return merged;
}
