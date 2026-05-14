/**
 * GET /api/admin/upload-settings — return doc_type_override_v1 config + flag state.
 * POST /api/admin/upload-settings — update enabled + config knobs.
 *
 * Knobs:
 *   - enabled (boolean): kill switch; when false, all overrides bypassed
 *   - classifier_confidence_override (0-1 float): Rule 1 threshold (default 0.8)
 *   - sbc_max_pages (positive integer): Rule 2 SBC-max ceiling (default 20)
 *
 * S91 — admin tuning surface for the doc-type resolver. See
 * `src/lib/documents/effective-doc-type.ts` + `src/lib/config/doc-type-override-config.ts`.
 *
 * Auth: Firebase bearer token + users.is_admin = true.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { logAdminAction } from "@/lib/admin/audit-log";
import { DEFAULT_DOC_TYPE_OVERRIDE_CONFIG } from "@/lib/documents/effective-doc-type";

const FLAG_KEY = "doc_type_override_v1";

async function verifyAdmin(req: NextRequest): Promise<
  | { authorized: false }
  | { authorized: true; adminUserId: string; adminEmail: string }
> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { authorized: false };

  try {
    const decoded = await getAdminAuth().verifyIdToken(authHeader.slice(7));
    const supabase = createServerClient();
    const { data } = await supabase
      .from("users")
      .select("id, email, is_admin")
      .eq("firebase_uid", decoded.uid)
      .single();
    if (!data?.is_admin) return { authorized: false };
    return {
      authorized: true,
      adminUserId: data.id as string,
      adminEmail: (data.email as string) ?? "",
    };
  } catch {
    return { authorized: false };
  }
}

interface FlagRow {
  enabled: boolean;
  config: Record<string, unknown> | null;
  description: string | null;
}

function rowToResponse(row: FlagRow | null) {
  if (!row) {
    return {
      enabled: DEFAULT_DOC_TYPE_OVERRIDE_CONFIG.enabled,
      classifier_confidence_override:
        DEFAULT_DOC_TYPE_OVERRIDE_CONFIG.classifier_confidence_override,
      sbc_max_pages: DEFAULT_DOC_TYPE_OVERRIDE_CONFIG.sbc_max_pages,
      rowExists: false,
      description: null as string | null,
    };
  }
  const raw = (row.config ?? {}) as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    classifier_confidence_override:
      typeof raw.classifier_confidence_override === "number"
        ? raw.classifier_confidence_override
        : DEFAULT_DOC_TYPE_OVERRIDE_CONFIG.classifier_confidence_override,
    sbc_max_pages:
      typeof raw.sbc_max_pages === "number"
        ? raw.sbc_max_pages
        : DEFAULT_DOC_TYPE_OVERRIDE_CONFIG.sbc_max_pages,
    rowExists: true,
    description: row.description,
  };
}

export async function GET(req: NextRequest) {
  const auth = await verifyAdmin(req);
  if (!auth.authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  const auth = await verifyAdmin(req);
  if (!auth.authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be boolean" },
      { status: 400 },
    );
  }

  const classifierConfidenceOverride = body.classifier_confidence_override;
  if (
    typeof classifierConfidenceOverride !== "number" ||
    classifierConfidenceOverride < 0 ||
    classifierConfidenceOverride > 1
  ) {
    return NextResponse.json(
      { error: "classifier_confidence_override must be a number between 0 and 1" },
      { status: 400 },
    );
  }

  const sbcMaxPages = body.sbc_max_pages;
  if (typeof sbcMaxPages !== "number" || sbcMaxPages <= 0 || sbcMaxPages > 200) {
    return NextResponse.json(
      { error: "sbc_max_pages must be a positive integer between 1 and 200" },
      { status: 400 },
    );
  }

  const config = {
    classifier_confidence_override: classifierConfidenceOverride,
    sbc_max_pages: Math.round(sbcMaxPages),
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
        "S91 (Session 91). Effective doc-type resolver — admin-tunable via /admin/upload-settings.",
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
    action: "upload_settings.update",
    targetTable: "feature_flag_rules",
    details: `flag_key=${FLAG_KEY} enabled=${enabled} classifier_confidence_override=${config.classifier_confidence_override} sbc_max_pages=${config.sbc_max_pages}`,
  });

  return NextResponse.json({
    success: true,
    enabled,
    classifier_confidence_override: config.classifier_confidence_override,
    sbc_max_pages: config.sbc_max_pages,
    rowExists: true,
  });
}
