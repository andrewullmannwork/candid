/**
 * GET /api/admin/classifier-fallback-settings — return classifier_haiku_regex_fallback_v1
 *   config + flag state.
 * POST /api/admin/classifier-fallback-settings — update enabled + config knobs.
 *
 * Knobs (S94 B5 — see mig 104 + src/lib/config/classifier-fallback-config.ts):
 *   - enabled (boolean): kill switch; when false, all three defenses bypass
 *   - haiku_failure_fallback ('regex'|'user_pick'): which classifier to trust
 *     when Haiku errors. Default 'regex'.
 *   - sanity_gate_enabled (boolean): refuse bill parser on suspected SBC
 *   - sanity_gate_min_pages (positive integer): refusal page-count floor
 *   - sanity_gate_sbc_phrase_count (positive integer): refusal phrase-count floor
 *   - confirmation_ui_enabled (boolean): halt + modal on moderate-conf disagreement
 *   - confirmation_regex_threshold (0-1 float): regex confidence floor for halt
 *
 * Auth: Firebase bearer token + users.is_admin = true.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { logAdminAction } from "@/lib/admin/audit-log";
import {
  DEFAULT_CLASSIFIER_FALLBACK_CONFIG,
  type HaikuFailureFallback,
} from "@/lib/config/classifier-fallback-config";

const FLAG_KEY = "classifier_haiku_regex_fallback_v1";

interface FlagRow {
  enabled: boolean;
  config: Record<string, unknown> | null;
  description: string | null;
}

function rowToResponse(row: FlagRow | null) {
  if (!row) {
    return {
      enabled: DEFAULT_CLASSIFIER_FALLBACK_CONFIG.enabled,
      haiku_failure_fallback: DEFAULT_CLASSIFIER_FALLBACK_CONFIG.haiku_failure_fallback,
      sanity_gate_enabled: DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_enabled,
      sanity_gate_min_pages: DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_min_pages,
      sanity_gate_sbc_phrase_count:
        DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_sbc_phrase_count,
      confirmation_ui_enabled: DEFAULT_CLASSIFIER_FALLBACK_CONFIG.confirmation_ui_enabled,
      confirmation_regex_threshold:
        DEFAULT_CLASSIFIER_FALLBACK_CONFIG.confirmation_regex_threshold,
      rowExists: false,
      description: null as string | null,
    };
  }
  const raw = (row.config ?? {}) as Record<string, unknown>;
  const fallback =
    raw.haiku_failure_fallback === "user_pick" || raw.haiku_failure_fallback === "regex"
      ? (raw.haiku_failure_fallback as HaikuFailureFallback)
      : DEFAULT_CLASSIFIER_FALLBACK_CONFIG.haiku_failure_fallback;
  return {
    enabled: row.enabled === true,
    haiku_failure_fallback: fallback,
    sanity_gate_enabled:
      typeof raw.sanity_gate_enabled === "boolean"
        ? raw.sanity_gate_enabled
        : DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_enabled,
    sanity_gate_min_pages:
      typeof raw.sanity_gate_min_pages === "number"
        ? raw.sanity_gate_min_pages
        : DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_min_pages,
    sanity_gate_sbc_phrase_count:
      typeof raw.sanity_gate_sbc_phrase_count === "number"
        ? raw.sanity_gate_sbc_phrase_count
        : DEFAULT_CLASSIFIER_FALLBACK_CONFIG.sanity_gate_sbc_phrase_count,
    confirmation_ui_enabled:
      typeof raw.confirmation_ui_enabled === "boolean"
        ? raw.confirmation_ui_enabled
        : DEFAULT_CLASSIFIER_FALLBACK_CONFIG.confirmation_ui_enabled,
    confirmation_regex_threshold:
      typeof raw.confirmation_regex_threshold === "number"
        ? raw.confirmation_regex_threshold
        : DEFAULT_CLASSIFIER_FALLBACK_CONFIG.confirmation_regex_threshold,
    rowExists: true,
    description: row.description,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("feature_flag_rules")
    .select("enabled, config, description")
    .eq("flag_key", FLAG_KEY)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(rowToResponse(data as FlagRow | null));
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
  }

  const haikuFailureFallback = body.haiku_failure_fallback;
  if (haikuFailureFallback !== "regex" && haikuFailureFallback !== "user_pick") {
    return NextResponse.json(
      { error: "haiku_failure_fallback must be 'regex' or 'user_pick'" },
      { status: 400 },
    );
  }

  const sanityGateEnabled = body.sanity_gate_enabled;
  if (typeof sanityGateEnabled !== "boolean") {
    return NextResponse.json(
      { error: "sanity_gate_enabled must be boolean" },
      { status: 400 },
    );
  }

  const sanityGateMinPages = body.sanity_gate_min_pages;
  if (
    typeof sanityGateMinPages !== "number" ||
    sanityGateMinPages < 1 ||
    sanityGateMinPages > 500
  ) {
    return NextResponse.json(
      { error: "sanity_gate_min_pages must be an integer between 1 and 500" },
      { status: 400 },
    );
  }

  const sanityGateSbcPhraseCount = body.sanity_gate_sbc_phrase_count;
  if (
    typeof sanityGateSbcPhraseCount !== "number" ||
    sanityGateSbcPhraseCount < 1 ||
    sanityGateSbcPhraseCount > 10
  ) {
    return NextResponse.json(
      { error: "sanity_gate_sbc_phrase_count must be an integer between 1 and 10" },
      { status: 400 },
    );
  }

  const confirmationUiEnabled = body.confirmation_ui_enabled;
  if (typeof confirmationUiEnabled !== "boolean") {
    return NextResponse.json(
      { error: "confirmation_ui_enabled must be boolean" },
      { status: 400 },
    );
  }

  const confirmationRegexThreshold = body.confirmation_regex_threshold;
  if (
    typeof confirmationRegexThreshold !== "number" ||
    confirmationRegexThreshold < 0 ||
    confirmationRegexThreshold > 1
  ) {
    return NextResponse.json(
      { error: "confirmation_regex_threshold must be a number between 0 and 1" },
      { status: 400 },
    );
  }

  const config = {
    haiku_failure_fallback: haikuFailureFallback,
    sanity_gate_enabled: sanityGateEnabled,
    sanity_gate_min_pages: Math.round(sanityGateMinPages),
    sanity_gate_sbc_phrase_count: Math.round(sanityGateSbcPhraseCount),
    confirmation_ui_enabled: confirmationUiEnabled,
    confirmation_regex_threshold: confirmationRegexThreshold,
  };

  const supabase = createServerClient();
  const { data: existing } = await supabase
    .from("feature_flag_rules")
    .select("enabled, config")
    .eq("flag_key", FLAG_KEY)
    .maybeSingle();

  let upsertError;
  if (existing) {
    const { error } = await supabase
      .from("feature_flag_rules")
      .update({ enabled, config })
      .eq("flag_key", FLAG_KEY);
    upsertError = error;
  } else {
    const { error } = await supabase.from("feature_flag_rules").insert({
      flag_key: FLAG_KEY,
      enabled,
      target_type: "global",
      description:
        "S94 B5. Classifier Haiku→regex fallback + bill-parser sanity gate + doc-type confirmation modal — admin-tunable via /admin/classifier-fallback-settings.",
      config,
    });
    upsertError = error;
  }

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  await logAdminAction({
    adminUserId: auth.adminUserId,
    adminEmail: auth.adminEmail,
    action: "classifier_fallback_settings.update",
    targetTable: "feature_flag_rules",
    details: `flag_key=${FLAG_KEY} enabled=${enabled} haiku_failure_fallback=${config.haiku_failure_fallback} sanity_gate=${config.sanity_gate_enabled}/${config.sanity_gate_min_pages}/${config.sanity_gate_sbc_phrase_count} confirmation=${config.confirmation_ui_enabled}/${config.confirmation_regex_threshold}`,
  });

  return NextResponse.json({
    success: true,
    enabled,
    ...config,
    rowExists: true,
  });
}
