/**
 * Loader for the classifier_haiku_regex_fallback_v1 flag config.
 *
 * Pure loader — reads feature_flag_rules row + parses the config JSONB into
 * the typed ClassifierFallbackConfig shape. Falls back to safe defaults if:
 *   - Flag row is missing (mig 104 not yet applied)
 *   - Row exists but `enabled=false` (kill switch — returns enabled:false +
 *     all three defenses become no-ops)
 *   - config JSONB is malformed or missing expected keys
 *
 * Callers:
 *   - haiku-classify.ts caller (process-chunk route) reads
 *     `haiku_failure_fallback` to decide regex-vs-user pick when Haiku errors.
 *   - process-chunk route reads `sanity_gate_*` knobs before invoking the
 *     bill parser.
 *   - upload route reads `confirmation_*` knobs to decide whether to halt
 *     the pipeline at awaiting_doc_type_confirmation when regex disagrees
 *     with the user.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const FLAG_KEY = "classifier_haiku_regex_fallback_v1";

export type HaikuFailureFallback = "regex" | "user_pick";

export interface ClassifierFallbackConfig {
  enabled: boolean;
  haiku_failure_fallback: HaikuFailureFallback;
  sanity_gate_enabled: boolean;
  sanity_gate_min_pages: number;
  sanity_gate_sbc_phrase_count: number;
  confirmation_ui_enabled: boolean;
  confirmation_regex_threshold: number;
}

export const DEFAULT_CLASSIFIER_FALLBACK_CONFIG: ClassifierFallbackConfig = {
  enabled: false,
  haiku_failure_fallback: "regex",
  sanity_gate_enabled: true,
  sanity_gate_min_pages: 10,
  sanity_gate_sbc_phrase_count: 2,
  confirmation_ui_enabled: true,
  confirmation_regex_threshold: 0.5,
};

function parseFallback(raw: unknown): HaikuFailureFallback {
  if (raw === "regex" || raw === "user_pick") return raw;
  return DEFAULT_CLASSIFIER_FALLBACK_CONFIG.haiku_failure_fallback;
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  return typeof raw === "number" && raw > 0 ? Math.round(raw) : fallback;
}

function parseUnitFloat(raw: unknown, fallback: number): number {
  return typeof raw === "number" && raw >= 0 && raw <= 1 ? raw : fallback;
}

export async function loadClassifierFallbackConfig(
  supabase: SupabaseClient,
): Promise<ClassifierFallbackConfig> {
  try {
    const { data, error } = await supabase
      .from("feature_flag_rules")
      .select("enabled, config")
      .eq("flag_key", FLAG_KEY)
      .maybeSingle();

    if (error || !data) {
      return DEFAULT_CLASSIFIER_FALLBACK_CONFIG;
    }

    const enabled = data.enabled === true;
    const raw = (data.config ?? {}) as Record<string, unknown>;

    return {
      enabled,
      haiku_failure_fallback: parseFallback(raw.haiku_failure_fallback),
      sanity_gate_enabled: parseBool(
        raw.sanity_gate_enabled,
        DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_enabled,
      ),
      sanity_gate_min_pages: parsePositiveInt(
        raw.sanity_gate_min_pages,
        DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_min_pages,
      ),
      sanity_gate_sbc_phrase_count: parsePositiveInt(
        raw.sanity_gate_sbc_phrase_count,
        DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_sbc_phrase_count,
      ),
      confirmation_ui_enabled: parseBool(
        raw.confirmation_ui_enabled,
        DEFAULT_CLASSIFIER_FALLBACK_CONFIG.confirmation_ui_enabled,
      ),
      confirmation_regex_threshold: parseUnitFloat(
        raw.confirmation_regex_threshold,
        DEFAULT_CLASSIFIER_FALLBACK_CONFIG.confirmation_regex_threshold,
      ),
    };
  } catch (err) {
    console.warn("[classifier-fallback-config] load failed, using defaults:", err);
    return DEFAULT_CLASSIFIER_FALLBACK_CONFIG;
  }
}
