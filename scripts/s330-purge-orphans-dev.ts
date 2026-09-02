// S330 — DEV cleanup of Andrew's test bed: signed-instrument documents + consent rows whose engagement ref never
// landed (pre-atomic-merge failures), plus the Riverside + Northgate test engagements. Read-only listing first, then deletes.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpk")) { console.error("REFUSING: not DEV"); process.exit(2); }
const sb = createClient(url, key);
const uid = "2ce55772-bdf1-4edd-bd16-215aa239990e";
(async () => {
  const { data: docs } = await sb.from("documents").select("id, file_name, storage_path, consent_event_id, metadata, created_at").eq("user_id", uid).eq("doc_type", "other").gte("created_at", "2026-09-02T00:00:00Z");
  const { data: engs } = await sb.from("dfy_engagements").select("id, claim_id, status, consent_event_ids").eq("user_id", uid);
  const referenced = new Set<string>();
  for (const e of engs ?? []) for (const v of Object.values((e.consent_event_ids as Record<string, { eventId?: string }>) ?? {})) if (v?.eventId) referenced.add(v.eventId);
  const orphans = (docs ?? []).filter((d) => d.consent_event_id && !referenced.has(d.consent_event_id));
  console.log(`documents(other) today: ${(docs ?? []).length} · orphaned (no engagement ref): ${orphans.length}`);
  for (const d of orphans) {
    if (d.storage_path) await sb.storage.from("documents").remove([d.storage_path]);
    await sb.from("documents").delete().eq("id", d.id);
    if (d.consent_event_id) await sb.from("consent_events").delete().eq("id", d.consent_event_id);
    console.log("  removed", d.file_name, String(d.created_at).slice(11, 19));
  }
  // dangling consent rows for dfy instruments with no document and no ref (the health-data re-affirmation has no PDF)
  const { data: ce } = await sb.from("consent_events").select("id, consent_type, created_at").eq("user_id", uid).like("consent_type", "dfy_%").gte("created_at", "2026-09-02T00:00:00Z");
  const dangling = (ce ?? []).filter((c) => !referenced.has(c.id));
  for (const c of dangling) { await sb.from("consent_events").delete().eq("id", c.id); console.log("  removed consent", c.consent_type, String(c.created_at).slice(11, 19)); }
  // the test engagements themselves (Riverside applied; Northgate declined) + their dfy events
  for (const e of engs ?? []) {
    await sb.from("claim_case_events").delete().eq("claim_id", e.claim_id).like("kind", "dfy_%");
    await sb.from("dfy_engagements").delete().eq("id", e.id);
    console.log("  purged engagement", e.id.slice(0, 8), e.status, "claim", e.claim_id.slice(0, 8));
  }
  console.log("DEV test bed clean: no engagements on your claims, no orphaned signed PDFs.");
})();
