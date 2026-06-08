/**
 * Admin GET/POST for /admin/promotion-quarantine config (ID-Block §5, PR3b-2).
 *
 *   GET  → { config: <full IdBlockConfig (effective)>, defaults, flagEnabled }
 *   POST { config } → strict-validate → write id_block_corroboration.config JSONB →
 *          audit (before→after) → echo the EFFECTIVE parsed config + warnings.
 *
 * Writes ONLY the `config` column — never `enabled` (the gate on/off stays a separate
 * deliberate flip). The gate.mode field IS editable here (shadow ↔ active); flipping to
 * active is the operator's post-calibration call. Strict validation REJECTS bad input
 * (the read-path overlay silently coerces; the editor must not).
 *
 * Auth: admin-only (shared requireAdmin → users.is_admin; audited as users.id PK).
 * SoT: plans/id-block-corroboration-source-independence.md §5.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/require-admin";
import { ID_BLOCK_FLAG_KEY, loadIdBlockConfig, DEFAULT_ID_BLOCK_CONFIG } from "@/lib/parser/id-block/config";
import { validateIdBlockConfigInput } from "@/lib/parser/id-block/config-validation";
import { logAdminAction } from "@/lib/admin/audit-log";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const [config, flagRes] = await Promise.all([
    loadIdBlockConfig(supabase),
    supabase.from("feature_flag_rules").select("enabled").eq("flag_key", ID_BLOCK_FLAG_KEY).maybeSingle(),
  ]);
  return NextResponse.json({
    config,
    defaults: DEFAULT_ID_BLOCK_CONFIG,
    flagEnabled: (flagRes.data as { enabled?: boolean } | null)?.enabled === true,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase, adminUserId } = auth;

  let body: { config?: unknown };
  try {
    body = (await req.json()) as { config?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.config === undefined) return NextResponse.json({ error: "config required" }, { status: 400 });

  const validation = validateIdBlockConfigInput(body.config);
  if (!validation.ok) {
    return NextResponse.json({ error: "config validation failed", errors: validation.errors }, { status: 400 });
  }

  // Capture prior config for the audit diff (before the write).
  const before = await loadIdBlockConfig(supabase);

  const { error: updErr } = await supabase
    .from("feature_flag_rules")
    .update({ config: validation.config })
    .eq("flag_key", ID_BLOCK_FLAG_KEY);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Echo the EFFECTIVE parsed config (what actually took effect via the overlay) so the
  // admin can confirm there was no silent coercion.
  const effective = await loadIdBlockConfig(supabase);

  // Forensic audit trail (who/when/what — before→after). Non-fatal.
  try {
    const { data: adminRow } = await supabase.from("users").select("email").eq("id", adminUserId).maybeSingle();
    const adminEmail = (adminRow as { email?: string } | null)?.email ?? adminUserId;
    await logAdminAction({
      adminUserId,
      adminEmail,
      action: "id_block_config_update",
      targetTable: "feature_flag_rules",
      details: JSON.stringify({ flag: ID_BLOCK_FLAG_KEY, before, after: effective, warnings: validation.warnings }),
    });
  } catch (err) {
    console.warn("[promotion-quarantine/config] audit log failed (non-fatal):", err);
  }

  return NextResponse.json({ ok: true, config: effective, warnings: validation.warnings });
}
