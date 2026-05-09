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
import { callHaikuWithCache } from "./haiku-prompts/_shared";

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
 * "Important Questions" (federal SBC template), "Cost Share Summary", or similar.
 *
 * Services + cost-sharing section: typically appears as "Common Medical Events"
 * (federal SBC template), "Schedule of Benefits", "MEDICAL BENEFITS", or similar.
 *
 * Access-instructions section: typically appears near the end as "Member Services",
 * "Customer Service", "Important Phone Numbers", or "How to Access Care".
 *
 * S72 commit 6 (Session 75) — pattern set extended after empirical efficacy harness
 * surfaced 4 of 5 fixtures had plan_identity section UNDETECTED by initial regex set.
 * Patterns added based on observed real headings in BSCA EOC + Aetna Medicare EOC +
 * Kaiser Permanente EOC + Cigna Plan Benefits + Cigna current SBC.
 */
const SECTION_PATTERNS: SectionPattern[] = [
  {
    hint: "plan_identity",
    patterns: [
      /^\s*Plan\s+Information\b/im,
      /^\s*Plan\s+Summary\b/im,
      /^\s*Coverage\s+Information\b/im,
      /^\s*Plan\s+Identification\b/im,
      // S72 commit 6 additions (insurer-agnostic from empirical fixtures):
      /^\s*Important\s+Questions\b/im, // federal SBC template — Important Questions section has plan-identity scalars (Cigna SBC, Ambetter SBC, BSCA EOC observed)
      /^\s*Cost\s+Share\s+Summary\b/im, // Kaiser EOC — Cost Share Summary Tables include deductibles + OOP
      /^\s*Deductibles\s+and\s+Out[-\s]of[-\s]Pocket\b/im, // Kaiser EOC literal heading
      /^\s*Schedule\s+of\s+Cost[-\s]Sharing\b/im, // common variant
      /^\s*Accumulation\s+Period\b/im, // Kaiser EOC — accumulation period section has plan-year + deductible reset rules
      /^\s*Member\s+Coverage\b/im, // common variant
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
      // S72 commit 6 additions:
      /^\s*Common\s+Medical\s+Events?\b/im, // federal SBC template — services + per-service cost-sharing
      /^\s*Common\s+Healthcare\s+Events?\b/im, // SBC variant (Ambetter)
      /^\s*MEDICAL\s+BENEFITS\b/m, // Cigna plan_benefits pattern (all-caps; literal section title)
      /^\s*Cost\s+Share\s+Summary\s+Tables?\s+by\s+Benefit\b/im, // Kaiser EOC literal heading
      /^\s*The\s+Schedule\b/im, // Cigna plan_benefits pattern — "The Schedule" is the plan's services schedule
      /^\s*What\s+You\s+Will\s+Pay\b/im, // common variant in SBC + EOC tables
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
      // S72 commit 6 additions:
      /^\s*Important\s+Phone\s+Numbers\b/im, // Aetna Medicare EOC — "Important phone numbers and resources"
      /^\s*Member\s+Resources\b/im, // common variant
      /^\s*Getting\s+Help\b/im, // common variant
      /^\s*How\s+to\s+Reach\s+Us\b/im, // common variant
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
 * S72 commit 7 implementation (per S72-COMMIT-7 user direction "let Haiku do more
 * work; fidelity > cost"): instead of asking Haiku for character offsets directly
 * (brittle — Haiku is bad at counting chars), ask Haiku for distinctive OPENING
 * PHRASES per section, then use string-search to derive offsets. Cleaner contract;
 * verbatim-substring constraint guarantees the offset is real.
 *
 * Cost-discipline: for documents > DISCOVERY_MAX_INPUT_CHARS (~25K tokens), sample
 * the first 60K + last 30K chars (where plan-identity / access-instructions tend to
 * live) so the discovery call stays cheap (~$0.02-0.05) regardless of doc size.
 */

const DISCOVERY_INSTRUCTIONS = `You are identifying section boundaries in a health plan document. Return distinctive opening phrases (≤80 chars verbatim) for each of these 3 priority sections, OR null if not present.

## SECTIONS TO IDENTIFY

1. **plan_identity**: section containing plan-level scalars — carrier name, plan name, plan year, deductibles, out-of-pocket maximums, group number, network type. Often labeled "Plan Information", "Important Questions", "The Schedule", "Cost Share Summary", "Schedule of Benefits", or similar.

2. **services_cost_sharing**: section with per-service cost-sharing rows — primary care visit copay, specialist visit, ER, hospital stay, drugs, etc. Often labeled "Common Medical Events", "Schedule of Benefits", "MEDICAL BENEFITS", "Cost Share Summary Tables", or similar.

3. **access_instructions**: section with member services contact info — customer service phone, network finder URL, how to access care. Often labeled "Member Services", "Customer Service", "Important Phone Numbers", "Contact Information", or similar.

## CRITICAL RULES

1. **Verbatim opener** (≤80 chars): the opening line/phrase MUST be a CHARACTER-FOR-CHARACTER substring of the document text (matching exactly, including capitalization, punctuation, whitespace). NEVER paraphrase. If you can't find a clear opener for a section, return null for that section — null is preferred over a wrong opener.

2. **Opener uniqueness**: pick a phrase that's likely UNIQUE to this section (avoid generic phrases that appear multiple times in the doc, like "deductible" or "copay" alone).

3. **Section boundaries**: the opener marks the START of the section. The end is implicit (next section's opener OR end of document).

## RESPONSE SCHEMA

{
  "plan_identity_opener": "Important Questions" (or null),
  "services_cost_sharing_opener": "Common Medical Events" (or null),
  "access_instructions_opener": "Member Services" (or null)
}

## NOW IDENTIFY FROM THIS DOCUMENT TEXT:`;

interface DiscoveryResponse {
  plan_identity_opener?: string | null;
  services_cost_sharing_opener?: string | null;
  access_instructions_opener?: string | null;
}

const DISCOVERY_MAX_INPUT_CHARS = 100_000; // ~25K tokens; cheap discovery call

function sampleForDiscovery(text: string): string {
  if (text.length <= DISCOVERY_MAX_INPUT_CHARS) return text;
  // Take first 60K + last 30K chars (plan-identity tends to be early; access-instructions late).
  const firstPart = text.slice(0, 60_000);
  const lastPart = text.slice(text.length - 30_000);
  return firstPart + "\n\n[...DOCUMENT TRUNCATED FOR DISCOVERY; FULL DOC PROCESSED PER-SECTION DOWNSTREAM...]\n\n" + lastPart;
}

function findOpenerOffset(text: string, opener: string | null | undefined): number | null {
  if (!opener || typeof opener !== "string" || opener.length < 3) return null;
  const trimmed = opener.trim();
  if (trimmed.length < 3) return null;
  const idx = text.indexOf(trimmed);
  return idx >= 0 ? idx : null;
}

export async function discoverPlanDocSectionsViaHaiku(text: string): Promise<SectionRanges> {
  const sampled = sampleForDiscovery(text);

  let result;
  try {
    result = await callHaikuWithCache<DiscoveryResponse>({
      systemPrompt: DISCOVERY_INSTRUCTIONS,
      userContent: sampled,
      sectionLabel: "plan_doc_section_discovery",
    });
  } catch (err) {
    void err;
    return {};
  }

  // Map openers to offsets in the FULL text (not the sampled excerpt; sampled
  // is just for Haiku's discovery context — actual offsets are derived from full).
  const openers: Array<{ hint: PlanDocSectionHint; offset: number }> = [];
  const piOffset = findOpenerOffset(text, result.data.plan_identity_opener);
  const scsOffset = findOpenerOffset(text, result.data.services_cost_sharing_opener);
  const aiOffset = findOpenerOffset(text, result.data.access_instructions_opener);

  if (piOffset !== null) openers.push({ hint: "plan_identity", offset: piOffset });
  if (scsOffset !== null) openers.push({ hint: "services_cost_sharing", offset: scsOffset });
  if (aiOffset !== null) openers.push({ hint: "access_instructions", offset: aiOffset });

  // Sort by offset and compute end as next opener's start.
  openers.sort((a, b) => a.offset - b.offset);

  const ranges: SectionRanges = {};
  for (let i = 0; i < openers.length; i++) {
    const cur = openers[i];
    const next = openers[i + 1];
    const end = next?.offset ?? text.length;
    if (!ranges[cur.hint]) ranges[cur.hint] = [];
    ranges[cur.hint].push({ start: cur.offset, end });
  }

  return ranges;
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
