/**
 * Loader for the `ocr_undecodable_page_fallback_v1` flag config.
 *
 * Gates + tunes the per-page Document AI fallback in `src/lib/ocr/index.ts`:
 * when pdfjs draws text on a page but decodes ~nothing (a real text layer with
 * no ToUnicode CMap — e.g. some Kaiser/Antenna-House EOBs), that single page is
 * re-OCR'd via Document AI and spliced back, keeping pdfjs's byte-exact text for
 * every other page. See `plans/eob-ocr-per-page-fallback-hotfix.md`.
 *
 * Pure single-query loader (mirrors `classifier-fallback-config.ts`). Falls back
 * to safe defaults — with `enabled: false` — when the flag row is missing, the
 * row is disabled, or the config JSONB is malformed. Flag OFF ⇒ detection is
 * skipped entirely in the dispatcher ⇒ extraction is byte-identical to pre-fix.
 */

import { createServerClient } from "@/lib/supabase/server";

const FLAG_KEY = "ocr_undecodable_page_fallback_v1";

export interface OcrUndecodableFallbackConfig {
  enabled: boolean;
  /** A page is a detection candidate when its trimmed extracted length is below this. */
  candidateMaxChars: number;
  /** A candidate must draw at least this many text-show ops to be considered text-bearing. */
  minTextOps: number;
  /** A candidate is undecodable when extractedChars < textOps * minCharsPerOp. */
  minCharsPerOp: number;
}

export const DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG: OcrUndecodableFallbackConfig = {
  enabled: false, // OFF when no row → byte-identical to pre-fix until the seed mig turns it ON
  candidateMaxChars: 50,
  minTextOps: 10,
  minCharsPerOp: 1.0,
};

function parseNonNegNumber(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export async function loadOcrUndecodableFallbackConfig(): Promise<OcrUndecodableFallbackConfig> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("feature_flag_rules")
      .select("enabled, config")
      .eq("flag_key", FLAG_KEY)
      .maybeSingle();

    if (error || !data) return DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG;

    const raw = (data.config ?? {}) as Record<string, unknown>;
    return {
      enabled: data.enabled === true,
      candidateMaxChars: parseNonNegNumber(
        raw.candidate_max_chars,
        DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG.candidateMaxChars,
      ),
      minTextOps: parseNonNegNumber(
        raw.min_text_ops,
        DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG.minTextOps,
      ),
      minCharsPerOp: parseNonNegNumber(
        raw.min_chars_per_op,
        DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG.minCharsPerOp,
      ),
    };
  } catch (err) {
    console.warn(
      "[ocr-fallback-config] load failed, using defaults (enabled:false):",
      (err as Error).message,
    );
    return DEFAULT_OCR_UNDECODABLE_FALLBACK_CONFIG;
  }
}
