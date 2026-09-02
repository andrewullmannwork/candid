// S330 — reproduce Andrew's round-1 path: an APPLIED engagement (no operator, unscreened, intake {})
// on the Northgate claim → sign the authorization → does the ref land? Self-purging. DEV-guarded.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { parseEngagementRow } from "../src/lib/security/operator-scoped";
import { signInstrument, memberIsEligibleToSign } from "../src/lib/dfy/sign";
import { readDfyState } from "../src/lib/dfy/config";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, key);
(async () => {
  const claimId = "2a8f87c6-45e1-4c89-a96e-73a1803fe651"; const uid = "2ce55772-bdf1-4edd-bd16-215aa239990e";
  const { data: live } = await sb.from("dfy_engagements").select("id, status").eq("claim_id", claimId).in("status", ["eligibility_pending", "signed", "active"]);
  if ((live ?? []).length) { console.log("a live engagement exists on the claim — not seeding:", live); process.exit(0); }
  const now = new Date().toISOString();
  const { data: seeded, error } = await sb.from("dfy_engagements").insert({ user_id: uid, claim_id: claimId, status: "eligibility_pending", lane: "insurer", payer: "member_paid", member_state: "CA", intake: {}, metadata: { appliedBy: { actor: "user", userId: uid }, appliedAt: now, seededBy: "s330-probe-sign-applied.ts" } }).select("*").single();
  if (error) throw error;
  const e = parseEngagementRow(seeded)!;
  console.log("seeded applied engagement", e.id.slice(0, 8), "signable:", memberIsEligibleToSign(e), "operator:", e.operator_user_id);
  const state = await readDfyState(sb);
  let evId: string | null = null; let docId: string | null = null;
  try {
    const t0 = Date.now();
    const r = await signInstrument({ supabase: sb, engagement: e, member: { id: uid, email: "andrew.david.ullmann@gmail.com", displayName: "Andrew Ullmann" }, type: "dfy_authorization_hipaa_cmia", signedName: "Andrew Ullmann", ip: "127.0.0.1", userAgent: "probe", config: state.config });
    evId = r.ref.eventId; docId = r.ref.documentId;
    console.log(`signed in ${Date.now() - t0}ms → status ${r.engagement.status} · refs ${Object.keys(r.engagement.consent_event_ids).length} · completed ${r.completed}`);
    const { data: again } = await sb.from("dfy_engagements").select("consent_event_ids, status").eq("id", e.id).single();
    console.log("re-read:", again?.status, "refs", Object.keys((again?.consent_event_ids as Record<string, unknown>) ?? {}).join(","));
  } catch (err) { console.error("SIGN FAILED:", err); }
  // purge
  if (docId) { const { data: d } = await sb.from("documents").select("storage_path").eq("id", docId).maybeSingle(); if (d?.storage_path) await sb.storage.from("documents").remove([d.storage_path]); await sb.from("documents").delete().eq("id", docId); }
  if (evId) await sb.from("consent_events").delete().eq("id", evId);
  await sb.from("claim_case_events").delete().eq("claim_id", claimId).like("kind", "dfy_%").gte("occurred_at", now);
  await sb.from("dfy_engagements").delete().eq("id", e.id);
  console.log("purged");
})();
