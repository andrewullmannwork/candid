/**
 * EOC section segmentation per DR-3.1A-C.
 *
 * Two-pass segmentation:
 *   1. Regex pass — anchored heading vocabulary across 6 priority sections (A/B/C/D/F/K)
 *      + 3 boilerplate sections (header / footer / glossary).
 *   2. Haiku discovery fallback (Q-P3.1A-4 LOCK) — fires when regex finds <2 of 6
 *      priority sections. Asks Haiku to identify section page boundaries semantically.
 *
 * Preamble synthesis per Phase 3.1B.1 universal pattern: content before first heading
 * gets a synthetic `other` range. If no headings match at all, entire doc → `other`.
 *
 * Insurer-agnostic: all heading vocabulary is SEMANTIC (what the section IS), not
 * insurer-specific. Adding insurer-specific phrasing pollutes the regex.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SectionRanges } from "../parser/types";
import type { EOCSectionHint } from "./types";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

/**
 * Regex-based heading vocabulary for EOC sections.
 *
 * INSURER-AGNOSTIC SEMANTIC SYNONYMS ONLY — each phrase names what the section IS,
 * not how a particular insurer phrases it. If a fixture surfaces a section that needs
 * a new phrase, ask: "Is this how multiple insurers reasonably name this section?"
 * If yes, add. If no, reframe as a semantic synonym or skip.
 *
 * Anchor `^\s*` matches at line start with optional leading whitespace per Phase
 * 3.1B.1 mechanism — handles insurers (e.g., Cigna) that indent section headers.
 */
const SECTION_PATTERNS: Array<[EOCSectionHint, RegExp]> = [
  [
    "prior_auth_codes",
    // Insurer-agnostic semantic synonyms. Blue Shield + others use bare "Prior
    // Authorization" as a section heading (not "PRIOR AUTHORIZATION CODE LIST" with
    // qualifier suffix). Anchor on `^\s*` plus heading-like context (alone on line OR
    // followed by section-like punctuation).
    /^\s*(PRIOR AUTHORIZATION(?:\s+(?:CODE\s+)?(?:LIST|REQUIREMENTS|REQUEST(?:S)?))?|PRE.?AUTHORIZATION(?:\s+(?:CODE\s+)?LIST)?|SERVICES REQUIRING (?:PRIOR )?AUTHORIZATION|UTILIZATION (?:REVIEW|MANAGEMENT) CODES?|PRECERTIFICATION REQUIREMENTS?)\b/im,
  ],
  [
    "medical_necessity",
    // Same vocabulary-expansion approach. Blue Shield uses bare "Medical Necessity" as
    // a section heading (with period or alone on line). Other insurers use suffixed
    // variants. Both should match.
    /^\s*(MEDICAL NECESSITY(?:\s+(?:CRITERIA|GUIDELINES|REQUIREMENTS|DETERMINATION))?|MEDICALLY NECESSARY (?:CRITERIA|SERVICES)|CRITERIA FOR COVERAGE|COVERAGE CRITERIA|CLINICAL CRITERIA)\b/im,
  ],
  [
    "appeals_procedures",
    /^\s*(APPEALS? (?:PROCEDURES?|PROCESS|RIGHTS)|HOW TO (?:FILE AN |APPEAL)|INTERNAL (?:AND EXTERNAL )?(?:REVIEW|APPEAL)|EXTERNAL REVIEW|GRIEVANCE (?:PROCEDURES?|PROCESS|RIGHTS)|COMPLAINTS? AND APPEALS?)\b/im,
  ],
  [
    "cob_rules",
    /^\s*(COORDINATION OF BENEFITS|COB (?:RULES?|PROVISIONS?)|MULTIPLE (?:COVERAGE|INSURANCE)|WHEN YOU HAVE OTHER (?:COVERAGE|INSURANCE))\b/im,
  ],
  [
    "eligibility_rules",
    /^\s*(ELIGIBILITY (?:RULES?|REQUIREMENTS|AND ENROLLMENT)|WHO IS ELIGIBLE|ENROLLMENT (?:RULES?|REQUIREMENTS|PROCEDURES)|EFFECTIVE DATE|COBRA (?:CONTINUATION|COVERAGE)|SPECIAL ENROLLMENT|QUALIFYING (?:LIFE )?EVENTS?)\b/im,
  ],
  [
    "definitions",
    /^\s*(DEFINITIONS|GLOSSARY OF TERMS|KEY TERMS (?:AND DEFINITIONS)?|TERMS (?:YOU SHOULD KNOW|USED IN THIS (?:DOCUMENT|EVIDENCE OF COVERAGE))|MEANING OF (?:WORDS|TERMS))\b/im,
  ],
  [
    "header_DO_NOT_EXTRACT",
    /^\s*(EVIDENCE OF COVERAGE|CERTIFICATE OF (?:COVERAGE|INSURANCE)|MEMBER HANDBOOK|YOUR (?:HEALTH PLAN|BENEFITS)(?: OVERVIEW)?|WELCOME TO|TABLE OF CONTENTS)\b/im,
  ],
  [
    "footer_legalese_DO_NOT_EXTRACT",
    /^\s*(YOUR RIGHTS AND PROTECTIONS|NONDISCRIMINATION NOTICE|LANGUAGE ASSISTANCE|NOTICE OF PRIVACY PRACTICES|FRAUD WARNING|REGULATORY DISCLOSURES?)\b/im,
  ],
  [
    "glossary_legalese_DO_NOT_EXTRACT",
    /^\s*(DISCLAIMER|LEGAL NOTICE|IMPORTANT (?:LEGAL )?(?:NOTICE|INFORMATION)|RIGHTS RESERVED)\b/im,
  ],
];

/**
 * Regex-based segmentation. Returns SectionRanges keyed by EOCSectionHint string.
 *
 * Different from EOB segmentation: EOC priority sections (A/B/C/D/F/K) appear ONCE
 * each in the document — only the FIRST match per priority hint counts as the section
 * start. Subsequent matches are cross-references within other sections (e.g., a PA
 * code list would have many lines starting with "Prior Authorization" within other
 * sections). Boilerplate sections (header_DO_NOT_EXTRACT etc.) can have multiple
 * ranges per Pattern P-8 convention.
 *
 * Empirical: iteration 2 of session_51_phase31a_baseline showed that emitting one
 * range per match (EOB pattern) creates tiny slices between consecutive matches of
 * the same priority hint, causing Haiku to see fragments rather than full sections.
 * First-match-only restores section integrity.
 */
const PRIORITY_HINTS: Set<EOCSectionHint> = new Set([
  "prior_auth_codes",
  "medical_necessity",
  "appeals_procedures",
  "cob_rules",
  "eligibility_rules",
  "definitions",
]);

export function segmentEOCSections(rawDocText: string): SectionRanges {
  const matches: Array<{ hint: EOCSectionHint; start: number }> = [];
  const seenPriority: Set<EOCSectionHint> = new Set();

  for (const [hint, pattern] of SECTION_PATTERNS) {
    const flagged = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = flagged.exec(rawDocText)) !== null) {
      // First-match-per-priority-hint guard — drop subsequent matches of the same
      // priority section type (they're cross-references, not section starts).
      if (PRIORITY_HINTS.has(hint)) {
        if (seenPriority.has(hint)) continue;
        seenPriority.add(hint);
      }
      matches.push({ hint, start: m.index });
    }
  }

  matches.sort((a, b) => a.start - b.start);

  const result: SectionRanges = {};
  for (let i = 0; i < matches.length; i++) {
    const { hint, start } = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].start : rawDocText.length;
    if (!result[hint]) result[hint] = [];
    result[hint].push({ start, end });
  }

  // Preamble synthesis per Phase 3.1B.1 universal pattern.
  if (matches.length === 0) {
    result.other = [{ start: 0, end: rawDocText.length }];
  } else if (matches[0].start > 0) {
    result.other = result.other ?? [];
    result.other.unshift({ start: 0, end: matches[0].start });
  }

  return result;
}

/**
 * Count of priority sections (A/B/C/D/F/K) found by regex segmentation.
 * Used to decide whether section-discovery Haiku fallback fires (Q-P3.1A-4 LOCK).
 */
export function countPrioritySections(ranges: SectionRanges): number {
  const priorityHints: EOCSectionHint[] = [
    "prior_auth_codes",
    "medical_necessity",
    "appeals_procedures",
    "cob_rules",
    "eligibility_rules",
    "definitions",
  ];
  return priorityHints.filter((hint) => ranges[hint] && ranges[hint].length > 0).length;
}

/**
 * Section discovery fallback (Q-P3.1A-4 LOCK).
 *
 * Fires when regex finds <2 of 6 priority sections. Asks Haiku to identify the
 * character offsets where each priority section starts. Returns SectionRanges in
 * the same shape as regex segmentation; consumer merges via `mergeSegmentations()`.
 *
 * Cost: ~$0.02 per call (small prompt; no caching since called rarely).
 */
export async function discoverSectionsViaHaiku(rawDocText: string): Promise<SectionRanges> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[eoc/section-segment] ANTHROPIC_API_KEY not set; section discovery skipped");
    return {};
  }

  const client = new Anthropic({ apiKey, timeout: 60000, maxRetries: 2 });

  const prompt = `You are identifying where 6 named sections START in this Evidence of Coverage (EOC) document. Return a JSON object mapping each section name to the character offset (0-indexed) where its heading begins. Use null when the section is not present.

Section names + what they contain:
- prior_auth_codes: list of CPT/HCPCS codes that require prior authorization
- medical_necessity: diagnostic/treatment criteria per service
- appeals_procedures: how to file internal/external appeals + timing windows
- cob_rules: coordination of benefits when member has multiple insurance plans
- eligibility_rules: who is eligible, effective dates, COBRA, special enrollment
- definitions: legal definitions of terms (medical necessity, emergency, etc.)

Return ONLY a JSON object like:
{ "prior_auth_codes": 12345, "medical_necessity": null, "appeals_procedures": 23456, "cob_rules": 34567, "eligibility_rules": null, "definitions": 45678 }

Document text:
${rawDocText.slice(0, 50000)}`;

  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const offsets = JSON.parse(cleaned) as Record<string, number | null>;

    const ranges: SectionRanges = {};
    const validHints: EOCSectionHint[] = [
      "prior_auth_codes",
      "medical_necessity",
      "appeals_procedures",
      "cob_rules",
      "eligibility_rules",
      "definitions",
    ];

    // Build half-open ranges; each section ends at the next section's start (or doc end).
    const sortedEntries = validHints
      .map((hint) => ({ hint, offset: offsets[hint] }))
      .filter((e) => typeof e.offset === "number" && e.offset >= 0 && e.offset < rawDocText.length)
      .sort((a, b) => (a.offset as number) - (b.offset as number));

    for (let i = 0; i < sortedEntries.length; i++) {
      const { hint, offset } = sortedEntries[i];
      const end = i + 1 < sortedEntries.length ? (sortedEntries[i + 1].offset as number) : rawDocText.length;
      ranges[hint] = [{ start: offset as number, end }];
    }
    return ranges;
  } catch (err) {
    console.warn("[eoc/section-segment] discoverSectionsViaHaiku failed:", err);
    return {};
  }
}

/**
 * Merge two SectionRanges maps. Regex-found ranges take precedence (more reliable
 * heading anchors); Haiku-discovered ranges fill gaps for sections regex missed.
 */
export function mergeSegmentations(primary: SectionRanges, fallback: SectionRanges): SectionRanges {
  const merged: SectionRanges = { ...primary };
  for (const [hint, ranges] of Object.entries(fallback)) {
    if (!merged[hint] || merged[hint].length === 0) {
      merged[hint] = ranges;
    }
  }
  return merged;
}
