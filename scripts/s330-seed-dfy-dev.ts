// S330 DEV test-bed seed (DEV-guarded). NOT a production path — the real entry
// is the operator's "Invite a member" form → eligibility_pending → screening;
// `signed` is the member's own act (PR-DFY-2). This script seeds what PR-2 has
// not built yet so the operator surface can be exercised end to end.
//
//   npx tsx scripts/s330-seed-dfy-dev.ts flag on|off
//   npx tsx scripts/s330-seed-dfy-dev.ts operator <email> on|off
//   npx tsx scripts/s330-seed-dfy-dev.ts engagement <claimId> <memberEmail> eligibility_pending|signed|active [operatorEmail]
//   npx tsx scripts/s330-seed-dfy-dev.ts marketing-gate <YYYY-MM-DD|null>
//   npx tsx scripts/s330-seed-dfy-dev.ts purge <claimId>      (deletes the claim's engagements + dfy_* events)
//   npx tsx scripts/s330-seed-dfy-dev.ts config <key> <json>   (one dfy_operator_v1 config key, e.g. entry_point_enabled true · fee_cents 0)
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not the DEV project:", url); process.exit(2); }
const sb = createClient(url, key);
const [cmd, ...args] = process.argv.slice(2);

async function userByEmail(email: string) {
  const { data } = await sb.from("users").select("id, email").eq("email", email.toLowerCase()).maybeSingle();
  if (!data) throw new Error(`no user ${email}`);
  return data as { id: string; email: string };
}

async function main() {
  if (cmd === "flag") {
    const on = args[0] === "on";
    const { error } = await sb.from("feature_flag_rules").update({ enabled: on }).eq("flag_key", "dfy_operator_v1");
    if (error) throw error;
    console.log("dfy_operator_v1 →", on ? "ON" : "OFF");
  } else if (cmd === "operator") {
    const u = await userByEmail(args[0]);
    const { error } = await sb.from("users").update({ is_operator: args[1] === "on" }).eq("id", u.id);
    if (error) throw error;
    console.log(`${u.email} is_operator → ${args[1] === "on"}`);
  } else if (cmd === "marketing-gate") {
    const v = args[0] === "null" ? null : args[0];
    const { data } = await sb.from("feature_flag_rules").select("config").eq("flag_key", "dfy_operator_v1").single();
    const cfg = { ...((data?.config as Record<string, unknown>) ?? {}), marketing_gate_verified_on: v };
    const { error } = await sb.from("feature_flag_rules").update({ config: cfg }).eq("flag_key", "dfy_operator_v1");
    if (error) throw error;
    console.log("marketing_gate_verified_on →", v);
  } else if (cmd === "config") {
    const [k, raw] = args;
    if (!k || raw === undefined) throw new Error("config <key> <json>");
    const v = JSON.parse(raw) as unknown;
    const { data } = await sb.from("feature_flag_rules").select("config").eq("flag_key", "dfy_operator_v1").single();
    const cfg = { ...((data?.config as Record<string, unknown>) ?? {}), [k]: v };
    const { error } = await sb.from("feature_flag_rules").update({ config: cfg }).eq("flag_key", "dfy_operator_v1");
    if (error) throw error;
    console.log(`config.${k} →`, JSON.stringify(v), "· now:", JSON.stringify(cfg));
  } else if (cmd === "engagement") {
    const [claimId, memberEmail, status, operatorEmail] = args;
    const m = await userByEmail(memberEmail);
    const op = operatorEmail ? await userByEmail(operatorEmail) : null;
    const { data: claim } = await sb.from("claims").select("id, user_id, insurance_plan_id").eq("id", claimId).maybeSingle();
    if (!claim || claim.user_id !== m.id) throw new Error("claim is not the member's own");
    const { data: prof } = await sb.from("profiles").select("state").eq("user_id", m.id).maybeSingle();
    const { data: plan } = claim.insurance_plan_id
      ? await sb.from("insurance_plans").select("metadata").eq("id", claim.insurance_plan_id).maybeSingle()
      : { data: null };
    const cls = (plan?.metadata as Record<string, unknown> | null)?.regulatory_classification ?? null;
    const now = new Date().toISOString();
    const row: Record<string, unknown> = {
      user_id: m.id, claim_id: claimId, status, lane: "insurer", payer: "member_paid",
      member_state: prof?.state ?? null, plan_classification: cls,
      operator_user_id: op?.id ?? null,
      metadata: { seededBy: "s330-seed-dfy-dev.ts", seededAt: now, note: "DEV test bed — signed/active seeded because PR-DFY-2 (the paper stack) is not built" },
      ...(status === "signed" || status === "active" ? { signed_at: now, consent_event_ids: { seeded: true } } : {}),
      ...(status === "active" ? { activated_at: now, scope: { lane: "insurer", memberFilesAtStateLevel: true, feeWaived: "free_pilot", seeded: true } } : {}),
    };
    const { data, error } = await sb.from("dfy_engagements").insert(row).select("id, status, operator_user_id").single();
    if (error) throw error;
    console.log("seeded engagement:", JSON.stringify(data));
  } else if (cmd === "purge") {
    const claimId = args[0];
    const e = await sb.from("dfy_engagements").delete().eq("claim_id", claimId).select("id");
    const ev = await sb.from("claim_case_events").delete().eq("claim_id", claimId).like("kind", "dfy_%").select("id");
    console.log(`purged engagements=${e.data?.length ?? 0} dfy events=${ev.data?.length ?? 0}`);
  } else {
    console.log("usage: flag on|off · operator <email> on|off · engagement <claimId> <memberEmail> <status> [operatorEmail] · marketing-gate <date|null> · purge <claimId> · config <key> <json>");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
