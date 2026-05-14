/**
 * Effective doc-type resolver — picks the doc_type the parser pipeline should
 * actually use, given a user's pick from the upload form + the quick-classifier's
 * verdict + confidence + page count.
 *
 * Two rules, in priority order:
 *
 *   Rule 1 (PRIMARY) — Classifier high-confidence override:
 *     If classifierConfidence >= CLASSIFIER_CONFIDENCE_OVERRIDE AND classifier
 *     disagrees with user, use the classifier's verdict.
 *     Catches: user picks "SBC" on a 150-page EOC; user picks "EOB" on an
 *     itemized bill; user picks "Plan Doc" on a 6-page actual SBC; etc.
 *
 *   Rule 2 (SAFETY NET) — SBC max-pages override:
 *     If user picks SBC AND pageCount > SBC_MAX_PAGES, force plan_document.
 *     Asymmetric on purpose — SBCs have a hard regulatory page ceiling (8 by
 *     federal rule, ~15-20 with state addenda max). Pages > 20 is an objective
 *     contradiction; safe to override even when classifier confidence is low.
 *     No reverse safety net (pages < N → SBC) because Plan Docs / SOBs / SPDs
 *     legitimately span a wide page range.
 *
 * Both knobs are admin-tunable via the `doc_type_override_v1` feature flag
 * config JSONB (see `src/lib/config/doc-type-override-config.ts`). The
 * resolver itself accepts the config as a typed object; the config-loader is
 * a separate module so this helper stays pure + unit-testable.
 *
 * S91 (Session 91). Background: PR #74 Bug X+Y closed a silent data-corruption
 * hole when SBC parser stochastically returned null on plan-identity. A 150-page
 * Cigna 2024 EOC uploaded as "SBC" surfaced the next layer: SBC parser ran on a
 * non-SBC document, extracted the PEO sponsor as insurer ("Sequoia One PEO,
 * LLC"), and Bug Y mismatch fired vs the user's actual Cigna plan. Root cause
 * was parser routing (user picked SBC; classifier's plan_document verdict
 * was shadow-stored but ignored). This resolver closes that gap.
 */

export type DocTypePick = "eob" | "itemized_bill" | "sbc" | "plan_document";

/**
 * Internal doc types the classifier may emit. Superset of DocTypePick — the
 * classifier can output "eoc" as a granular subtype of plan_document.
 */
export type ClassifiedDocType = DocTypePick | "eoc";

export type EffectiveDocType = ClassifiedDocType;

export type OverrideReason =
  | "user_pick" // classifier agreed with user; no override
  | "user_pick_classifier_low_confidence" // classifier disagreed but conf < threshold
  | "classifier_high_confidence" // Rule 1 fired
  | "page_count_safety_net" // Rule 2 fired
  | "feature_disabled"; // kill switch — flag disabled; trust user pick always

export interface DocTypeOverrideConfig {
  /** Override behavior is active when true. Set to false for an emergency kill switch. */
  enabled: boolean;
  /** Minimum classifier confidence (0-1) at which we override user's pick. Default 0.8. */
  classifier_confidence_override: number;
  /** Max page count for an SBC; over this triggers the safety net. Default 20. */
  sbc_max_pages: number;
}

export const DEFAULT_DOC_TYPE_OVERRIDE_CONFIG: DocTypeOverrideConfig = {
  enabled: true,
  classifier_confidence_override: 0.8,
  sbc_max_pages: 20,
};

export interface DocTypeResolution {
  effectiveDocType: EffectiveDocType;
  overrideReason: OverrideReason;
  userPick: DocTypePick;
  classifierType: string;
  classifierConfidence: number;
  pageCount: number;
}

/**
 * Resolve the doc_type the parser pipeline should use. Pure function — no I/O,
 * no DB, no logging. Caller is responsible for persisting the resolution and
 * logging.
 *
 * The classifierType param is typed as string (not ClassifiedDocType) because
 * the classifier is Haiku-driven and may occasionally emit a value outside our
 * enum (e.g., "card", "unknown"). The resolver does NOT validate the classifier
 * output — it only overrides when classifier reports a recognized type that
 * differs from user pick. Unrecognized classifier values fall through to
 * user_pick.
 */
export function resolveEffectiveDocType(
  userPick: DocTypePick,
  classifierType: string,
  classifierConfidence: number,
  pageCount: number,
  config: DocTypeOverrideConfig = DEFAULT_DOC_TYPE_OVERRIDE_CONFIG,
): DocTypeResolution {
  const baseResolution = {
    userPick,
    classifierType,
    classifierConfidence,
    pageCount,
  };

  // Kill switch — flag disabled. Always trust user pick.
  if (!config.enabled) {
    return {
      ...baseResolution,
      effectiveDocType: userPick,
      overrideReason: "feature_disabled",
    };
  }

  const recognizedClassifierTypes: ClassifiedDocType[] = [
    "eob",
    "itemized_bill",
    "sbc",
    "plan_document",
    "eoc",
  ];
  const classifierTypeIsRecognized = recognizedClassifierTypes.includes(
    classifierType as ClassifiedDocType,
  );

  // Rule 1 — Classifier high-confidence override.
  // Note: user picks "plan_document" but classifier says "eoc" still triggers
  // an override (eoc is the granular subtype). That's intentional — eoc routes
  // to the dedicated EOC parser internally.
  if (
    classifierTypeIsRecognized &&
    classifierConfidence >= config.classifier_confidence_override &&
    classifierType !== userPick
  ) {
    return {
      ...baseResolution,
      effectiveDocType: classifierType as ClassifiedDocType,
      overrideReason: "classifier_high_confidence",
    };
  }

  // Rule 2 — SBC max-pages safety net.
  if (userPick === "sbc" && pageCount > config.sbc_max_pages) {
    // Prefer the classifier's verdict if it disagrees with user (and is a
    // recognized non-sbc type). Fall back to plan_document if classifier
    // agreed with user (says sbc) or emitted an unrecognized value.
    const fallback: ClassifiedDocType =
      classifierTypeIsRecognized && classifierType !== "sbc"
        ? (classifierType as ClassifiedDocType)
        : "plan_document";
    return {
      ...baseResolution,
      effectiveDocType: fallback,
      overrideReason: "page_count_safety_net",
    };
  }

  // Default — trust user pick. Record whether the classifier merely agreed
  // (user_pick) or disagreed but with too-low confidence to override
  // (user_pick_classifier_low_confidence). The distinction helps tune
  // the confidence threshold post-MVP.
  const classifierAgreed = classifierType === userPick;
  return {
    ...baseResolution,
    effectiveDocType: userPick,
    overrideReason: classifierAgreed ? "user_pick" : "user_pick_classifier_low_confidence",
  };
}
