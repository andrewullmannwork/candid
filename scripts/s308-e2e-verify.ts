/**
 * S308 E2E verification sweep — READ-ONLY evidence gathering after Andrew's
 * Pass-1 legs (1A–1E). Prints, for the 8/21 claim:
 *   - every letter: status, updated_at, sentVersions stamp, Patient line,
 *     recipient/address block head — proves 1A rebuild, 1C indifference
 *     (the sent PROVIDER letter must still carry the pre-drift address),
 *     1E send stamp, corpse untouched.
 *   - the claim row: metadata keys + patient identity + any evidence
 *     perturbation left by 1D (userPatientPaid or override keys).
 *   - claim_case_events tail: spine emitters fired for today's actions.
 * DEV only. Zero writes.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url.includes("wdpkmgezhvlmaumhwqua")) {
  console.error(`REFUSING: ${new URL(url).host} is not DEV.`);
  process.exit(1);
}
const sb = createClient(url, key);
const CLAIM = "4e059cb9-44b4-4f7f-8958-91e8053225ff";

function excerpt(content: string | null, label: string): string {
  if (!content) return `${label}: (empty)`;
  const patient = content.split("\n").find((l) => /patient/i.test(l) && l.length < 120);
  const head = content.slice(0, 260).replace(/\n/g, " | ");
  return `${label}:\n    head: ${head}\n    patient-line: ${patient ?? "(none found)"}`;
}

async function main() {
  const { data: letters, error: e1 } = await sb
    .from("dispute_outcomes")
    .select("id, dispute_type, status, created_at, updated_at, letter_content, metadata")
    .eq("claim_id", CLAIM)
    .order("created_at", { ascending: true });
  if (e1) throw new Error("letters: " + e1.message);
  for (const l of letters ?? []) {
    const m = (l.metadata ?? {}) as Record<string, unknown>;
    const sv = m.sentVersions ? JSON.stringify(m.sentVersions).slice(0, 220) : "—";
    console.log(
      `\n■ ${(l.id as string).slice(0, 8)} type=${l.dispute_type} status=${l.status}\n  created=${l.created_at}\n  updated=${l.updated_at}\n  sentVersions: ${sv}\n  metadata keys: ${Object.keys(m).join(", ")}`,
    );
    console.log("  " + excerpt(l.letter_content as string | null, "content"));
  }

  const { data: claim, error: e2 } = await sb
    .from("claims")
    .select("id, total_patient_responsibility, metadata, updated_at")
    .eq("id", CLAIM)
    .single();
  if (e2) throw new Error("claim: " + e2.message);
  const cm = (claim!.metadata ?? {}) as Record<string, unknown>;
  console.log(`\n■ CLAIM updated=${claim!.updated_at}`);
  console.log(`  metadata keys: ${Object.keys(cm).join(", ")}`);
  for (const k of ["patient", "provider", "userPatientPaid", "costShareOverrides", "insurer"]) {
    if (cm[k] !== undefined) console.log(`  ${k}: ${JSON.stringify(cm[k]).slice(0, 400)}`);
  }
  const gs = cm.guideSteps as Record<string, unknown> | undefined;
  if (gs) {
    console.log(`  guideSteps keys (${Object.keys(gs).length}): ${Object.keys(gs).join(", ").slice(0, 400)}`);
  }

  const { data: events, error: e3 } = await sb
    .from("claim_case_events")
    .select("kind, created_at, payload")
    .eq("claim_id", CLAIM)
    .order("created_at", { ascending: false })
    .limit(15);
  if (e3) throw new Error("events: " + e3.message);
  console.log(`\n■ claim_case_events (newest 15):`);
  for (const ev of events ?? []) {
    console.log(`  ${ev.created_at}  ${ev.kind}  ${JSON.stringify(ev.payload).slice(0, 140)}`);
  }
}
main().catch((e) => {
  console.error("VERIFY FAILED:", e.message);
  process.exit(1);
});
// appended: newest sentVersion vs current content + identity answer (PROBE_SENT=1)
if (process.env.PROBE_SENT) {
  (async () => {
    const sb2 = createClient(url, key);
    const { data: l, error } = await sb2
      .from("dispute_outcomes")
      .select("id, status, letter_content, metadata")
      .eq("id", "994dca8c-5342-4029-97f9-581219060fb3")
      .single();
    if (error) throw new Error(error.message);
    const m = (l!.metadata ?? {}) as Record<string, unknown>;
    const sv = (m.sentVersions ?? []) as Array<{ body?: string; sentAt?: string; unsentAt?: string }>;
    console.log(`status=${l!.status} sentVersions count=${sv.length}`);
    sv.forEach((v, i) => {
      console.log(`  [${i}] sentAt=${v.sentAt ?? "?"} unsentAt=${v.unsentAt ?? "—"} bodyHead="${(v.body ?? "").slice(0, 120).replace(/\n/g, " | ")}"`);
    });
    const newest = sv[sv.length - 1];
    const match = newest?.body != null && newest.body === l!.letter_content;
    console.log(`newest sent body === current content: ${match}`);
    console.log(`patientIdentityChoice=${JSON.stringify(m.patientIdentityChoice)} patientCorrectedName=${JSON.stringify(m.patientCorrectedName)} resolved=${JSON.stringify(m.patientIdentityResolved)}`);
  })().catch((e) => { console.error("SENT FAIL:", e.message); process.exit(1); });
}
// appended: user profile state (PROBE_STATE=1)
if (process.env.PROBE_STATE) {
  (async () => {
    const sb3 = createClient(url, key);
    const { data: u, error } = await sb3
      .from("profiles")
      .select("state, plan_source")
      .eq("user_id", "2ce55772-bdf1-4edd-bd16-215aa239990e")
      .maybeSingle();
    if (error) {
      // column guess may 42703 — fall back to full row keys
      const { data: u2, error: e2 } = await sb3.from("users").select("*").eq("id", "2ce55772-bdf1-4edd-bd16-215aa239990e").single();
      if (e2) throw new Error(e2.message);
      const row = u2 as Record<string, unknown>;
      console.log("users columns:", Object.keys(row).join(", "));
      for (const k of Object.keys(row)) {
        if (/state|address|zip/i.test(k)) console.log(`  ${k}: ${JSON.stringify(row[k])}`);
      }
      return;
    }
    console.log("user state fields:", JSON.stringify(u));
  })().catch((e) => { console.error("STATE FAIL:", e.message); process.exit(1); });
}
// appended: whitelist-risk scan (PROBE_WL=1) — any row with null sent_at whose
// status is neither the draft status nor cancelled would be frozen by a
// live-draft whitelist; count them before proposing it.
if (process.env.PROBE_WL) {
  (async () => {
    const sb5 = createClient(url, key);
    const { data, error } = await sb5
      .from("dispute_outcomes")
      .select("id, status, sent_at, dispute_type, created_at")
      .is("sent_at", null)
      .not("status", "in", "(dispute_letter_drafted,cancelled)");
    if (error) throw new Error(error.message);
    console.log(`null-sent_at rows outside {drafted,cancelled}: ${data!.length}`);
    for (const r of data ?? []) console.log(`  ${(r.id as string).slice(0, 8)} status=${r.status} type=${r.dispute_type} created=${r.created_at}`);
  })().catch((e) => { console.error("WL FAIL:", e.message); process.exit(1); });
}
// appended: user-stated pcs rows (PROBE_STATED=1) — which claims already carry
// an answered rate, for the AU answered-chip DEV drive.
if (process.env.PROBE_STATED) {
  (async () => {
    const sb6 = createClient(url, key);
    const { data, error } = await sb6
      .from("plan_covered_services")
      .select("insurance_plan_id, in_copay, in_coinsurance, source, field_provenance, service_catalog!inner(slug)")
      .eq("source", "manual");
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const fp = r.field_provenance as Record<string, { source?: string }> | null;
      const who = fp?.in_copay?.source ?? fp?.in_coinsurance?.source ?? "(none)";
      const slug = (r.service_catalog as unknown as { slug: string } | null)?.slug;
      console.log(`stated: plan=${(r.insurance_plan_id as string).slice(0, 8)} ${slug} copay=${r.in_copay} coins=${r.in_coinsurance} provenance=${who}`);
    }
    console.log(`total manual rows: ${data!.length}`);
  })().catch((e) => { console.error("STATED FAIL:", e.message); process.exit(1); });
}
// appended: acupuncture write check (PROBE_ACU=1)
if (process.env.PROBE_ACU) {
  (async () => {
    const sb7 = createClient(url, key);
    const { data, error } = await sb7
      .from("plan_covered_services")
      .select("insurance_plan_id, in_copay, in_coinsurance, in_deductible_applies, covered, source, confidence, field_provenance, service_catalog!inner(slug)")
      .eq("service_catalog.slug", "acupuncture");
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      console.log(`acu row: plan=${(r.insurance_plan_id as string).slice(0, 8)} copay=${r.in_copay} coins=${r.in_coinsurance} dedApplies=${r.in_deductible_applies} source=${r.source} conf=${r.confidence}`);
      console.log(`  provenance: ${JSON.stringify(r.field_provenance).slice(0, 300)}`);
    }
    console.log(`rows: ${data!.length}`);
  })().catch((e) => { console.error("ACU FAIL:", e.message); process.exit(1); });
}
// appended: plan-id match check (PROBE_PLANID=1)
if (process.env.PROBE_PLANID) {
  (async () => {
    const sb8 = createClient(url, key);
    const { data: c } = await sb8.from("claims").select("id, insurance_plan_id").eq("id", "db733d7c-ee70-4e9e-856a-5575f7a22dde").single();
    console.log(`claim db733d7c plan = ${c!.insurance_plan_id}`);
    const { data: p } = await sb8.from("insurance_plans").select("id, plan_name, plan_year, is_active, user_id").eq("id", c!.insurance_plan_id as string).single();
    console.log(`  → ${p!.plan_name} year=${p!.plan_year} active=${p!.is_active}`);
    console.log(`write landed on plan de086649… — match: ${(c!.insurance_plan_id as string).startsWith("de086649")}`);
  })().catch((e) => { console.error("PLANID FAIL:", e.message); process.exit(1); });
}
