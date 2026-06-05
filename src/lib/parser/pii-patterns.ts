/**
 * Ing-E — PII pattern library (Phase 0, S165).
 *
 * Universal-first PII detection for the canonical, cross-user free-text stores
 * that copy verbatim document excerpts across users (where Pattern 1 #9
 * originator-anonymity actually bites):
 *   - canonical_plans.field_provenance.<field>.sources[].excerpt
 *   - canonical_plan_services.field_provenance.<field>.sources[].excerpt
 *   - billing_code_identity.corroborator_sources[].raw_description
 *   - canonical_haiku_extractions.source_excerpt
 *   - billing_code_mappings.description_signature
 *
 * DESIGN (locked S165):
 *  - UNIVERSAL structural patterns are the core defense — insurer-agnostic per
 *    [[feedback_universal_fixes_only]]. Per-insurer member-ID FORMATS are
 *    ADDITIVE recall boosters (kind:'insurer-format'), individually tested,
 *    NEVER a runtime branch on insurer identity.
 *  - COVERAGE_GUARD is a never-redact denylist (currency / percentage / coverage
 *    keywords). findPiiMatches() flags any PII match overlapping a guard span as
 *    `suppressedByCoverageGuard`; the Phase-2 redactor MUST NOT redact those.
 *    This structurally enforces the Q1 hard constraint: never corrupt a coverage
 *    excerpt / never delete important data.
 *  - confidence:'auto'  → high-specificity; safe to auto-redact (Phase 2).
 *    confidence:'review' → low-specificity OR semantically risky (names); SURFACED
 *    in the audit + counted, but NEVER auto-redacted until Phase 1 adjudication
 *    promotes it. Names live here on purpose (Q4: decide regex-vs-NER after the
 *    Phase 1 measurement; a name false-positive is the most likely way to clobber
 *    coverage/plan-name text, so it stays out of the auto path).
 *
 * This module is DORMANT in Phase 0/1 — imported only by the audit script + the
 * fixture. The redactor wiring (Phase 2) is flag-gated → byte-identical PROD OFF.
 */

export type PiiPatternKind = "universal" | "insurer-format";
export type PiiConfidence = "auto" | "review";

export interface PiiPattern {
  /** Stable id — used as the [REDACTED:<name>] marker tag + audit/telemetry key. */
  name: string;
  kind: PiiPatternKind;
  /** MUST carry the global flag (findPiiMatches relies on exec()+lastIndex). */
  regex: RegExp;
  confidence: PiiConfidence;
  /** Optional post-match validator (e.g. NPI Luhn). Match kept only if true. */
  validate?: (matchValue: string) => boolean;
  notes: string;
}

export interface PiiMatch {
  patternName: string;
  kind: PiiPatternKind;
  confidence: PiiConfidence;
  start: number;
  end: number;
  value: string;
  /** True when the match overlaps a COVERAGE_GUARD span → MUST NOT be redacted. */
  suppressedByCoverageGuard: boolean;
}

/**
 * NPI check-digit validation (CMS Luhn variant: prefix "80840" + first 9 digits,
 * Luhn over the 14, compare to the 10th digit). Cuts random-10-digit false
 * positives ~10x. Verified against canonical valid NPI 1234567893.
 */
export function isValidNpi(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 10) return false;
  const base = "80840" + digits.slice(0, 9);
  let sum = 0;
  let double = true; // rightmost of `base` is doubled (check digit excluded)
  for (let i = base.length - 1; i >= 0; i--) {
    let d = base.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(9) - 48;
}

/**
 * The pattern library. Order is irrelevant (findPiiMatches runs all; the redactor
 * dedupes overlapping spans). Every regex is global; `/i` where case varies.
 */
export const PII_PATTERNS: readonly PiiPattern[] = [
  // ── Universal — AUTO (high specificity; ~zero coverage-token overlap) ──
  {
    name: "ssn",
    kind: "universal",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    confidence: "auto",
    notes: "US SSN ###-##-####. High specificity; rare in plan/bill text but critical.",
  },
  {
    name: "email",
    kind: "universal",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: "auto",
    notes: "Email address.",
  },
  {
    name: "npi_labeled",
    kind: "universal",
    regex: /\bNPI\s*[:#]?\s*\d{10}\b/gi,
    confidence: "auto",
    notes: "Labeled NPI (10 digits). Label is enough signal; no Luhn required.",
  },
  {
    name: "npi_luhn",
    kind: "universal",
    regex: /\b\d{10}\b/g,
    confidence: "auto",
    validate: isValidNpi,
    notes: "Bare 10-digit run that passes the NPI checksum. Luhn-gated to cut FPs.",
  },
  {
    name: "member_id_labeled",
    kind: "universal",
    regex: /\b(?:member|subscriber|policy|enrollee|insured|beneficiary)\s*(?:id|identification|number|no\.?|#|num)?\s*[:#]\s*[A-Za-z0-9][A-Za-z0-9-]{4,}\b/gi,
    confidence: "auto",
    notes: "Member/Subscriber/Policy ID after a person-coverage label + : or #.",
  },
  {
    name: "group_number_labeled",
    kind: "universal",
    regex: /\bgroup\s*(?:id|number|no\.?|#|num)?\s*[:#]\s*[A-Za-z0-9][A-Za-z0-9-]{2,}\b/gi,
    confidence: "auto",
    notes: "Group number after a 'group' label + : or #. Colon/# req'd to avoid prose 'group 1'.",
  },
  {
    name: "dob_labeled",
    kind: "universal",
    regex: /\b(?:DOB|D\.O\.B\.?|date\s+of\s+birth|birth\s*date)\s*[:#]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi,
    confidence: "auto",
    notes: "DOB-labeled date only. Bare dates NOT matched (plan years are dates too).",
  },
  {
    name: "account_claim_labeled",
    kind: "universal",
    regex: /\b(?:account|acct\.?|claim)\s*(?:id|number|no\.?|#|num)?\s*[:#]\s*[A-Za-z0-9][A-Za-z0-9-]{4,}\b/gi,
    confidence: "auto",
    notes: "Account/claim number after a label + : or #.",
  },
  {
    name: "phone_labeled",
    kind: "universal",
    regex: /\b(?:phone|tel|telephone|fax|mobile|cell)\s*[:#]?\s*(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/gi,
    confidence: "auto",
    notes: "Phone/fax after a label. Bare phones are 'review' (phone_bare).",
  },

  // ── Insurer-format boosters — AUTO (specific shapes; individually tested) ──
  // Phase 1 audit data DRIVES adding/refining the rest (UHC/Cigna/Anthem). These
  // are recall boosters over the universal labeled patterns for UNLABELED IDs.
  {
    name: "insurer_aetna_w_id",
    kind: "insurer-format",
    regex: /\bW\d{9}\b/g,
    confidence: "auto",
    notes: "Aetna member ID shape: 'W' + 9 digits.",
  },
  {
    name: "insurer_bcbs_alpha_prefix",
    kind: "insurer-format",
    regex: /\b[A-Z]{3}\d{8,11}\b/g,
    confidence: "auto",
    notes: "BCBS shape: 3-letter alpha prefix + 8-11 digits.",
  },

  // ── REVIEW — surfaced + counted, NEVER auto-redacted until Phase 1 promotes ──
  {
    name: "name_labeled",
    kind: "universal",
    regex: /\b(?:patient|member|subscriber|insured|enrollee|beneficiary|guarantor|policyholder)(?:\s+name)?\s*[:#]\s*[A-Za-z][a-zA-Z'’.-]+(?:\s+[A-Za-z][a-zA-Z'’.-]+){1,3}\b/gi,
    confidence: "review",
    notes: "Person name after a person-context label (case-insensitive label via /i). RECALL-biased for the audit — review-tier, never auto-redacted, human adjudicates precision (feedback_candid_recall_over_precision). 'review' (Q4): names are the FP→coverage/plan-name corruption risk; promote only after adjudication. Standalone 'name' is intentionally excluded so 'Plan name: Gold PPO' does NOT match (no label word precedes 'name').",
  },
  {
    name: "phone_bare",
    kind: "universal",
    regex: /\b(?:\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
    confidence: "review",
    notes: "Unlabeled phone shape. 'review' — collides with some formatted IDs.",
  },
  {
    name: "long_alnum_id_run",
    kind: "universal",
    regex: /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]{9,}\b/gi,
    confidence: "review",
    notes: "Unlabeled mixed alpha+digit run ≥9 (ID-like), case-insensitive to catch lowercased description_signature values. 'review' — surfaces unlabeled member IDs for the audit; high FP, never auto.",
  },
];

/**
 * Coverage-bearing tokens the redactor must NEVER touch. A PII match overlapping
 * any of these spans is marked suppressedByCoverageGuard=true. Enforces the Q1
 * hard constraint structurally (independent of pattern precision).
 */
export const COVERAGE_GUARD: readonly { name: string; regex: RegExp }[] = [
  { name: "currency", regex: /\$\s?\d[\d,]*(?:\.\d{1,2})?/g },
  { name: "percentage", regex: /\b\d+(?:\.\d+)?\s?%/g },
  {
    name: "coverage_keyword",
    regex: /\b(?:copay|copayment|coinsurance|deductible|out[-\s]of[-\s]pocket|oop|allowance|premium|max(?:imum)?|per\s+(?:visit|day|admission|stay|month|year))\b/gi,
  },
];

function collectSpans(text: string, regex: RegExp): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function overlapsAny(start: number, end: number, spans: Array<[number, number]>): boolean {
  for (const [s, e] of spans) {
    if (start < e && s < end) return true; // half-open interval overlap
  }
  return false;
}

/**
 * Pure detection over a single text value. Returns EVERY match (auto + review),
 * each flagged for coverage-guard overlap. The audit (Phase 1) counts these; the
 * redactor (Phase 2) redacts only confidence==='auto' && !suppressedByCoverageGuard.
 * Non-mutating, deterministic — no I/O, no external calls.
 */
export function findPiiMatches(text: string | null | undefined): PiiMatch[] {
  if (!text) return [];
  const guardSpans: Array<[number, number]> = [];
  for (const g of COVERAGE_GUARD) {
    guardSpans.push(...collectSpans(text, g.regex));
  }
  const matches: PiiMatch[] = [];
  for (const p of PII_PATTERNS) {
    p.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.regex.exec(text)) !== null) {
      const value = m[0];
      if (value.length === 0) {
        p.regex.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + value.length;
      if (p.validate && !p.validate(value)) continue;
      matches.push({
        patternName: p.name,
        kind: p.kind,
        confidence: p.confidence,
        start,
        end,
        value,
        suppressedByCoverageGuard: overlapsAny(start, end, guardSpans),
      });
    }
  }
  return matches;
}

/** Convenience: the matches the Phase-2 redactor would actually act on. */
export function autoRedactableMatches(text: string | null | undefined): PiiMatch[] {
  return findPiiMatches(text).filter(
    (m) => m.confidence === "auto" && !m.suppressedByCoverageGuard,
  );
}

/**
 * Does this text contain any coverage-bearing token? Used by the audit to
 * stratify PII matches as "header-bleed" (co-located with coverage text) vs
 * "inherent" (standalone) — informs whether P-8 excerpt-boundary tightening
 * (the paired root-cause fix) would reduce the PII surface.
 */
export function hasCoverageTokens(text: string | null | undefined): boolean {
  if (!text) return false;
  return COVERAGE_GUARD.some((g) => {
    g.regex.lastIndex = 0;
    return g.regex.test(text);
  });
}
