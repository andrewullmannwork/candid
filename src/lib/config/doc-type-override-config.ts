/**
 * Loader for the doc_type_override_v1 flag config.
 *
 * Pure loader — reads feature_flag_rules row + parses the config JSONB into
 * the typed DocTypeOverrideConfig shape. Falls back to defaults if:
 *   - Flag row is missing (mig 099 not yet applied)
 *   - Row exists but `enabled=false` (kill switch — returns enabled:false)
 *   - config JSONB is malformed or missing expected keys
 *
 * Caller (the upload route) passes the resolved config to
 * resolveEffectiveDocType. Admin UI writes via PATCH on the same row.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_DOC_TYPE_OVERRIDE_CONFIG,
  type DocTypeOverrideConfig,
} from "@/lib/documents/effective-doc-type";

const FLAG_KEY = "doc_type_override_v1";

export async function loadDocTypeOverrideConfig(
  supabase: SupabaseClient,
): Promise<DocTypeOverrideConfig> {
  try {
    const { data, error } = await supabase
      .from("feature_flag_rules")
      .select("enabled, config")
      .eq("flag_key", FLAG_KEY)
      .maybeSingle();

    if (error || !data) {
      // Flag row missing (mig 099 not applied) — fall back to defaults but keep
      // override behavior active. The defaults match what the admin would set
      // anyway, so missing-row degradation is graceful.
      return DEFAULT_DOC_TYPE_OVERRIDE_CONFIG;
    }

    const enabled = data.enabled === true;
    const raw = (data.config ?? {}) as Record<string, unknown>;

    const classifierConfidenceOverride =
      typeof raw.classifier_confidence_override === "number" &&
      raw.classifier_confidence_override >= 0 &&
      raw.classifier_confidence_override <= 1
        ? raw.classifier_confidence_override
        : DEFAULT_DOC_TYPE_OVERRIDE_CONFIG.classifier_confidence_override;

    const sbcMaxPages =
      typeof raw.sbc_max_pages === "number" && raw.sbc_max_pages > 0
        ? Math.round(raw.sbc_max_pages)
        : DEFAULT_DOC_TYPE_OVERRIDE_CONFIG.sbc_max_pages;

    const familyRefinementConfidence =
      typeof raw.family_refinement_confidence === "number" &&
      raw.family_refinement_confidence >= 0 &&
      raw.family_refinement_confidence <= 1
        ? raw.family_refinement_confidence
        : DEFAULT_DOC_TYPE_OVERRIDE_CONFIG.family_refinement_confidence;

    return {
      enabled,
      classifier_confidence_override: classifierConfidenceOverride,
      sbc_max_pages: sbcMaxPages,
      family_refinement_confidence: familyRefinementConfidence,
    };
  } catch (err) {
    console.warn("[doc-type-override-config] load failed, using defaults:", err);
    return DEFAULT_DOC_TYPE_OVERRIDE_CONFIG;
  }
}
