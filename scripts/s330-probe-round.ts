// S330 DEV read-only: what happened on the Northgate + Riverside claims (engagements, refs, decision, dfy events).
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, key);
(async () => {
  const claims = ["2a8f87c6-45e1-4c89-a96e-73a1803fe651", "12da5f48-5199-4067-8bd2-700d38bdd807"];
  const { data: engs, error } = await sb.from("dfy_engagements").select("id, claim_id, status, payer, operator_user_id, consent_event_ids, intake, metadata, created_at, signed_at, closed_at").in("claim_id", claims).order("created_at");
  if (error) { console.error(error); process.exit(1); }
  for (const e of engs ?? []) {
    const refs = Object.keys((e.consent_event_ids as Record<string, unknown>) ?? {});
    const decision = (e.intake as { decision?: { eligible?: boolean; declineReason?: string } })?.decision;
    console.log(`engagement ${e.id.slice(0, 8)} · claim ${e.claim_id.slice(0, 8)} · ${e.status} · ${e.payer} · operator ${e.operator_user_id ? e.operator_user_id.slice(0, 8) : "—"} · signed refs ${refs.length} [${refs.map((r) => r.replace("dfy_", "")).join(", ")}] · decision ${decision ? (decision.eligible ? "eligible" : `declined: ${decision.declineReason}`) : "unscreened"} · closed ${e.closed_at ?? "—"} · closedReason ${(e.metadata as { closedReason?: string })?.closedReason ?? "—"}`);
    const { data: ev } = await sb.from("claim_case_events").select("kind, actor, occurred_at").eq("claim_id", e.claim_id).like("kind", "dfy_%").order("occurred_at");
    console.log("  events:", (ev ?? []).map((x) => `${x.kind}/${x.actor}`).join(" · "));
  }
  const { data: docs } = await sb.from("documents").select("id, file_name, status, consent_event_id, created_at").eq("doc_type", "other").order("created_at", { ascending: false }).limit(8);
  console.log("recent 'other' documents:", (docs ?? []).map((d) => `${d.file_name} (${d.status})`).join(" · "));
  console.log("NEXT_PUBLIC_APP_URL =", process.env.NEXT_PUBLIC_APP_URL);
})();
