/**
 * Ing-E Phase 2 — PII redactor (the write-path safety net).
 *
 * Replaces AUTO-confidence, non-coverage-guarded PII matches with
 * [REDACTED:<pattern>] markers before a verbatim excerpt is written to a
 * canonical / cross-user store. Review-tier matches and coverage-guard-overlapping
 * matches are NEVER redacted (Q1: never corrupt a coverage excerpt; Q4: names are
 * review-tier until adjudication promotes them).
 *
 * Pure + deterministic. Returns the input UNCHANGED when there is nothing to
 * redact, so callers can wire it unconditionally behind the `pii_redaction_enabled`
 * flag and stay byte-identical when OFF (and a no-op even when ON if the text has
 * no auto-tier PII).
 *
 * Ordering invariant (the cite-grade contract): the P-8 verbatim verifier runs at
 * PARSE time against raw OCR, BEFORE any canonical write — so redaction here never
 * affects verification. The stored excerpt is redacted; the verifier already passed.
 */
import { findPiiMatches, type PiiMatch } from "./pii-patterns";

export interface Redaction {
  patternName: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  /** The redacted text. Identical to the input when nothing was redacted. */
  redacted: string;
  /** Auto-tier spans that were replaced (for telemetry / G7 recall-loss detection). */
  redactions: Redaction[];
  /** Review-tier matches surfaced but NOT redacted (admin / telemetry). */
  reviewFlagged: PiiMatch[];
  /** True when at least one auto-tier redaction was applied. */
  changed: boolean;
}

const MARKER = (name: string): string => `[REDACTED:${name}]`;

/**
 * Redact auto-tier, non-coverage-guarded PII from `text`. Overlapping auto spans
 * are merged (outermost wins) so markers never nest.
 */
export function redactText(text: string | null | undefined): RedactionResult {
  if (!text) {
    return { redacted: text ?? "", redactions: [], reviewFlagged: [], changed: false };
  }
  const matches = findPiiMatches(text);
  const review = matches.filter((m) => m.confidence === "review");
  const auto = matches
    .filter((m) => m.confidence === "auto" && !m.suppressedByCoverageGuard)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  if (auto.length === 0) {
    return { redacted: text, redactions: [], reviewFlagged: review, changed: false };
  }

  // Merge overlapping / adjacent-overlapping auto spans (no nested markers).
  const merged: Redaction[] = [];
  for (const m of auto) {
    const last = merged[merged.length - 1];
    if (last && m.start <= last.end) {
      if (m.end > last.end) last.end = m.end; // extend; keep first pattern name
    } else {
      merged.push({ patternName: m.patternName, start: m.start, end: m.end });
    }
  }

  let out = "";
  let cursor = 0;
  for (const seg of merged) {
    out += text.slice(cursor, seg.start) + MARKER(seg.patternName);
    cursor = seg.end;
  }
  out += text.slice(cursor);

  return { redacted: out, redactions: merged, reviewFlagged: review, changed: true };
}

/** Convenience for callers that only need the string. */
export function redact(text: string | null | undefined): string {
  return redactText(text).redacted;
}
