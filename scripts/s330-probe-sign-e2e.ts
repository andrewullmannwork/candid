// S330 DEV proof-of-fire for the signing pipeline (server-side, no browser):
// seeds a throwaway engagement on one of the admin's claims (NEVER the S329
// Northgate test claim), signs all five instruments through signInstrument,
// verifies every artifact (consent events, PDFs in storage, member-owned
// documents rows, engagement refs, status), then PURGES everything it made.
// DEV-guarded. `--keep` skips the purge.
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
import { createClient } from "@supabase/supabase-js";
import { signInstrument, memberIsEligibleToSign } from "../src/lib/dfy/sign";
import { requiredDfyConsents, signedInstruments } from "../src/lib/dfy/paper";
import { parseEngagementRow, DFY_ENGAGEMENT_COLUMNS } from "../src/lib/security/operator-scoped";
import { readDfyState } from "../src/lib/dfy/config";

const NORTHGATE = "2a8f87c6-45e1-4c89-a96e-73a1803fe651";
const sb = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const keep = process.argv.includes("--keep");

async function main() {
  const { data: admin } = await sb.from("users").select("id, email, display_name").eq("is_admin", true).limit(1).single();
  const { data: claims } = await sb.from("claims").select("id, date_of_service, metadata").eq("user_id", admin!.id).is("deleted_at", null).order("created_at", { ascending: false });
  const live = await sb.from("dfy_engagements").select("claim_id").in("status", ["eligibility_pending", "signed", "active"]);
  const busy = new Set((live.data ?? []).map((r) => r.claim_id));
  const claim = (claims ?? []).find((c) => c.id !== NORTHGATE && !busy.has(c.id));
  if (!claim) throw new Error("no spare claim for the proof");
  console.log("member:", admin!.email, "| claim:", claim.id, claim.date_of_service, (claim.metadata as { provider?: { name?: string } })?.provider?.name);

  const now = new Date().toISOString();
  const { data: seeded, error: seedErr } = await sb.from("dfy_engagements").insert({
    user_id: admin!.id, claim_id: claim.id, status: "eligibility_pending", lane: "insurer", payer: "member_paid",
    operator_user_id: admin!.id, member_state: "CA",
    intake: { decision: { eligible: true, gates: [], declineReason: null }, screenedAt: now, seededForProof: true },
    metadata: { seededBy: "s330-probe-sign-e2e.ts", seededAt: now },
  }).select(DFY_ENGAGEMENT_COLUMNS).single();
  if (seedErr) throw seedErr;
  let e = parseEngagementRow(seeded)!;
  console.log("seeded engagement", e.id, "eligible-to-sign:", memberIsEligibleToSign(e));
  const { config } = await readDfyState(sb);
  const member = { id: admin!.id, email: admin!.email as string, displayName: (admin!.display_name as string | null) ?? null };
  const created: { events: string[]; docs: string[]; paths: string[] } = { events: [], docs: [], paths: [] };
  try {
    for (const type of requiredDfyConsents("member_paid")) {
      const t0 = Date.now();
      const r = await signInstrument({ supabase: sb, engagement: e, member, type, signedName: "Andrew Ullmann", ip: "127.0.0.1", userAgent: "s330-probe", config });
      e = r.engagement;
      created.events.push(r.ref.eventId);
      if (r.ref.documentId) created.docs.push(r.ref.documentId);
      console.log(`signed ${type} in ${Date.now() - t0}ms → event ${r.ref.eventId.slice(0, 8)} doc ${r.ref.documentId?.slice(0, 8) ?? "—"} completed=${r.completed} status=${e.status}`);
    }
    // verify
    const refs = signedInstruments(e.consent_event_ids);
    console.log("refs:", Object.keys(refs).length, "| status:", e.status, "(expected signed — composition proof absent on this claim, so not active)");
    const { data: evs } = await sb.from("consent_events").select("id, consent_type, consent_version, consent_text_hash").in("id", created.events);
    console.log("consent_events:", (evs ?? []).map((x) => `${x.consent_type}@${x.consent_version}:${String(x.consent_text_hash).slice(0, 8)}`).join(" | "));
    const { data: docs } = await sb.from("documents").select("id, user_id, doc_type, status, file_name, file_size, storage_path, consent_event_id").in("id", created.docs);
    for (const d of docs ?? []) {
      created.paths.push(d.storage_path);
      const dl = await sb.storage.from("documents").download(d.storage_path);
      const bytes = dl.data ? (await dl.data.arrayBuffer()).byteLength : -1;
      const head = dl.data ? Buffer.from(await dl.data.slice(0, 5).arrayBuffer()).toString() : "";
      console.log(`document ${d.id.slice(0, 8)} owner=${d.user_id === admin!.id ? "member ✓" : "WRONG"} type=${d.doc_type} status=${d.status} "${d.file_name}" size=${d.file_size} storage=${bytes}B ${head === "%PDF-" ? "PDF ✓" : "NOT PDF"} consent_event=${d.consent_event_id === refs[(d.file_name.includes("Authorization") ? "dfy_authorization_hipaa_cmia" : "dfy_scope_of_engagement")]?.eventId ? "own ✓" : "(other instrument)"}`);
    }
    const { data: spine } = await sb.from("claim_case_events").select("kind, actor, occurred_at").eq("claim_id", claim.id).like("kind", "dfy_%").order("occurred_at");
    console.log("spine:", (spine ?? []).map((s) => `${s.kind}/${s.actor}`).join(" · "));
  } finally {
    if (keep) { console.log("KEEPING test artifacts:", e.id); return; }
    if (created.paths.length) await sb.storage.from("documents").remove(created.paths);
    if (created.docs.length) await sb.from("documents").delete().in("id", created.docs);
    if (created.events.length) await sb.from("consent_events").delete().in("id", created.events);
    await sb.from("claim_case_events").delete().eq("claim_id", claim.id).like("kind", "dfy_%");
    await sb.from("dfy_engagements").delete().eq("id", e.id);
    console.log("purged: engagement, events, documents, storage objects, consent rows");
  }
}
main().catch((err) => { console.error("PROOF FAILED:", err); process.exit(1); });
