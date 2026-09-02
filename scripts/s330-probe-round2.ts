import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, key);
(async () => {
  const uid = "2ce55772-bdf1-4edd-bd16-215aa239990e";
  const since = "2026-09-02T00:00:00Z";
  const { data: ce, error: e1 } = await sb.from("consent_events").select("id, consent_type, created_at").eq("user_id", uid).gte("created_at", since).order("created_at");
  console.log("consent_events today:", e1 ?? (ce ?? []).map((r) => `${r.consent_type}@${String(r.created_at).slice(11, 19)}`).join(" · "));
  const { data: docs, error: e2 } = await sb.from("documents").select("id, file_name, status, consent_event_id, created_at").eq("user_id", uid).eq("doc_type", "other").gte("created_at", since).order("created_at");
  console.log("documents(other) today:", e2 ?? (docs ?? []).map((d) => `${d.file_name} ${String(d.created_at).slice(11, 19)} ce=${d.consent_event_id ? "yes" : "no"}`).join(" · "));
  const { data: eng } = await sb.from("dfy_engagements").select("id, status, created_at, updated_at, signed_at, closed_at, consent_event_ids").eq("claim_id", "2a8f87c6-45e1-4c89-a96e-73a1803fe651").maybeSingle();
  console.log("engagement:", eng ? `${eng.id.slice(0, 8)} ${eng.status} created ${String(eng.created_at).slice(11, 19)} updated ${String(eng.updated_at).slice(11, 19)} closed ${eng.closed_at ? String(eng.closed_at).slice(11, 19) : "—"} refs=${JSON.stringify(eng.consent_event_ids)}` : "none");
  for (const t of ["claims", "insurance_plans", "documents"]) {
    const { data, error } = await sb.from(t).select("*").limit(1).maybeSingle();
    console.log(`${t} columns:`, error ? error.message : Object.keys(data ?? {}).join(", "));
  }
  const { data: plan } = await sb.from("claims").select("insurance_plan_id, metadata").eq("id", "2a8f87c6-45e1-4c89-a96e-73a1803fe651").maybeSingle();
  const pid = (plan as { insurance_plan_id?: string } | null)?.insurance_plan_id;
  console.log("northgate claim metadata keys:", Object.keys(((plan as { metadata?: Record<string, unknown> } | null)?.metadata) ?? {}).join(", "));
  if (pid) { const { data: p } = await sb.from("insurance_plans").select("plan_name, insurer_name, plan_type, metadata").eq("id", pid).maybeSingle(); const m = (p as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}; console.log("plan:", (p as { plan_name?: string } | null)?.plan_name, "·", (p as { insurer_name?: string } | null)?.insurer_name, "·", (p as { plan_type?: string } | null)?.plan_type, "· metadata keys:", Object.keys(m).join(", "), "· regulatory_classification:", JSON.stringify(m.regulatory_classification ?? null).slice(0, 300)); }
  const { data: gs } = await sb.from("claim_case_events").select("kind, payload, occurred_at").eq("claim_id", "2a8f87c6-45e1-4c89-a96e-73a1803fe651").in("kind", ["ground_selected", "letter_adopted"]).order("occurred_at", { ascending: false }).limit(2);
  for (const g of gs ?? []) console.log(`${g.kind} payload:`, JSON.stringify(g.payload).slice(0, 400));
})();
