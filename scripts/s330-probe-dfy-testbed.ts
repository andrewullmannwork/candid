// S330 DEV probe (read-only): admin users, and claims that carry the member's
// own composition events (ground_selected + letter_adopted) — the only claims a
// DFY matter can be seeded on. DEV-guarded.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, key);
async function main() {
  const admins = await sb.from("users").select("id, email, is_admin, is_operator").eq("is_admin", true);
  console.log("admins:", JSON.stringify(admins.data));
  const ev = await sb.from("claim_case_events").select("claim_id, user_id, kind, occurred_at").in("kind", ["ground_selected", "letter_adopted"]).order("occurred_at", { ascending: false }).limit(60);
  const byClaim = new Map<string, { user: string; kinds: Set<string>; last: string }>();
  for (const e of ev.data ?? []) {
    const c = byClaim.get(e.claim_id) ?? { user: e.user_id, kinds: new Set<string>(), last: e.occurred_at };
    c.kinds.add(e.kind); byClaim.set(e.claim_id, c);
  }
  for (const [claimId, c] of byClaim) {
    const claim = await sb.from("claims").select("id, metadata, insurance_plan_id, date_of_service").eq("id", claimId).maybeSingle();
    const user = await sb.from("users").select("email").eq("id", c.user).maybeSingle();
    const prof = await sb.from("profiles").select("state").eq("user_id", c.user).maybeSingle();
    const meta = (claim.data?.metadata ?? {}) as Record<string, unknown>;
    const prov = (meta.provider as { name?: string } | undefined)?.name ?? "?";
    const disputes = await sb.from("dispute_outcomes").select("id, dispute_type, status, governing_deadline_date, metadata").eq("claim_id", claimId);
    const ds = (disputes.data ?? []).map((d) => `${d.dispute_type}/${d.status}/ddl=${d.governing_deadline_date ?? "-"}/denial=${(d.metadata as Record<string, unknown> | null)?.denialNoticeDate ?? "-"}`).join(" | ");
    const eng = await sb.from("dfy_engagements").select("id, status").eq("claim_id", claimId);
    console.log(`claim ${claimId} · ${prov} · dos ${claim.data?.date_of_service} · member ${user.data?.email} (${prof.data?.state ?? "state?"}) · kinds ${[...c.kinds].join("+")} · last ${c.last.slice(0, 10)} · letters: ${ds || "none"} · engagements: ${eng.data?.length ?? 0}`);
  }
}
main();
