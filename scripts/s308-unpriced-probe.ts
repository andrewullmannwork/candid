/**
 * S308 read-only probe — find DEV claims with a genuinely UNPRICED line
 * (the Confirm-your-rate E2E leg). Mirrors recovery-math's service_cost
 * assumption condition:
 *   unpriced = service identity present AND stance != not_covered
 *              AND resolved copay == null AND resolved coinsurance == null
 *              (service row value ?? plan.in_coinsurance_default)
 *              AND not preventive
 * ZERO writes. DEV only (.env.local).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) throw new Error("missing env");
console.log("DB host:", new URL(url).host);
const sb = createClient(url, key);

async function main() {
  // 1. resolve the DEV user from the known 8/21 claim
  const { data: anchor, error: e1 } = await sb
    .from("claims")
    .select("id, user_id")
    .gte("id", "4e059cb9-0000-0000-0000-000000000000")
    .lt("id", "4e059cb9-ffff-ffff-ffff-ffffffffffff")
    .limit(1);
  if (e1) throw new Error("anchor: " + e1.message);
  if (!anchor?.length) throw new Error("anchor claim not found");
  const userId = anchor[0].user_id as string;
  console.log("anchor claim:", anchor[0].id, "user:", userId);

  // 2. all live claims for the user
  const { data: claims, error: e2 } = await sb
    .from("claims")
    .select("id, date_of_service, total_billed, total_patient_responsibility, status, insurance_plan_id, created_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (e2) throw new Error("claims: " + e2.message);
  console.log("live claims:", claims!.length);

  // 3. letters per claim (non-cancelled = work, mirrors dedupe)
  const { data: letters, error: e3 } = await sb
    .from("dispute_outcomes")
    .select("claim_id, status, dispute_type")
    .eq("user_id", userId);
  if (e3) throw new Error("letters: " + e3.message);
  const lettersByClaim = new Map<string, string[]>();
  for (const l of letters ?? []) {
    if (!l.claim_id || l.status === "cancelled") continue;
    const arr = lettersByClaim.get(l.claim_id) ?? [];
    arr.push(`${l.dispute_type}:${l.status}`);
    lettersByClaim.set(l.claim_id, arr);
  }

  const claimIds = claims!.map((c) => c.id);
  // 4. line items
  const { data: lines, error: e4 } = await sb
    .from("claim_line_items")
    .select("id, claim_id, service_slug, description, billed_amount, metadata")
    .in("claim_id", claimIds);
  if (e4) throw new Error("lines: " + e4.message);

  // 5. plans (default coinsurance)
  const planIds = Array.from(new Set(claims!.map((c) => c.insurance_plan_id).filter(Boolean)));
  const { data: plans, error: e5 } = await sb
    .from("insurance_plans")
    .select("id, plan_name, in_coinsurance_default, is_active, canonical_plan_id")
    .in("id", planIds as string[]);
  if (e5) throw new Error("plans: " + e5.message);
  const planById = new Map((plans ?? []).map((p) => [p.id, p]));

  // 6. pcs rows for those plans
  const { data: pcs, error: e6 } = await sb
    .from("plan_covered_services")
    .select("insurance_plan_id, covered, in_copay, in_coinsurance, place_of_service, component, service_catalog!inner(slug)")
    .in("insurance_plan_id", planIds as string[]);
  if (e6) throw new Error("pcs: " + e6.message);
  const pcsKey = (pid: string, slug: string) => `${pid}::${slug}`;
  const pcsMap = new Map<string, Array<Record<string, unknown>>>();
  for (const r of pcs ?? []) {
    const slug = (r.service_catalog as unknown as { slug: string } | null)?.slug ?? "";
    const k = pcsKey(r.insurance_plan_id as string, slug);
    const arr = pcsMap.get(k) ?? [];
    arr.push(r);
    pcsMap.set(k, arr);
  }

  // 6b. canonical per-service rows (S288/S290 read-time fallback — prices lines
  // the user pcs never captured; the reason a raw pcs read under-counts pricing)
  const canonIds = Array.from(new Set((plans ?? []).map((p) => p.canonical_plan_id).filter(Boolean)));
  const cpsMap = new Map<string, Array<Record<string, unknown>>>();
  if (canonIds.length) {
    const { data: cps, error: e7 } = await sb
      .from("canonical_plan_services")
      .select("canonical_plan_id, service_slug, covered, in_copay, in_coinsurance")
      .in("canonical_plan_id", canonIds as string[]);
    if (e7) throw new Error("cps: " + e7.message);
    for (const r of cps ?? []) {
      const k = `${r.canonical_plan_id}::${r.service_slug}`;
      const arr = cpsMap.get(k) ?? [];
      arr.push(r);
      cpsMap.set(k, arr);
    }
  }

  // preventive slugs never fire the service_cost assumption (engine excludes them)
  const PREVENTIVE = new Set(["annual_physical", "immunizations", "preventive_care", "well_woman_visit"]);

  // 7. evaluate per claim
  for (const c of claims!) {
    const plan = c.insurance_plan_id ? planById.get(c.insurance_plan_id) : null;
    const defCoins = plan ? (plan.in_coinsurance_default as number | null) : null;
    const myLines = (lines ?? []).filter((l) => l.claim_id === c.id);
    const lw = lettersByClaim.get(c.id) ?? [];
    const flags: string[] = [];
    for (const l of myLines) {
      if (!l.service_slug) {
        flags.push(`  line(no-slug): "${String(l.description).slice(0, 40)}" $${l.billed_amount} → unpriced but NO chip (no identity)`);
        continue;
      }
      if (PREVENTIVE.has(l.service_slug)) continue;
      const rows = pcsMap.get(pcsKey(c.insurance_plan_id as string, l.service_slug)) ?? [];
      const canonRows = plan?.canonical_plan_id
        ? (cpsMap.get(`${plan.canonical_plan_id}::${l.service_slug}`) ?? [])
        : [];
      const anyPriced =
        rows.some((r) => r.in_copay != null || r.in_coinsurance != null) ||
        canonRows.some((r) => r.in_copay != null || r.in_coinsurance != null);
      const notCovered =
        (rows.length > 0 && rows.every((r) => r.covered === false)) ||
        (rows.length === 0 && canonRows.length > 0 && canonRows.every((r) => r.covered === false));
      if (notCovered) continue;
      if (!anyPriced && defCoins == null) {
        flags.push(
          `  line UNPRICED+CHIP: slug=${l.service_slug} "${String(l.description).slice(0, 40)}" $${l.billed_amount} (pcs ${rows.length} / canonical ${canonRows.length})`,
        );
      }
    }
    const mark = flags.some((f) => f.includes("UNPRICED+CHIP")) ? "★" : flags.length ? "·" : " ";
    console.log(
      `${mark} claim ${c.id.slice(0, 8)} dos=${c.date_of_service} billed=$${c.total_billed} plan=${plan ? String(plan.plan_name).slice(0, 30) : "NONE"} defCoins=${defCoins} letters=[${lw.join(", ")}]`,
    );
    for (const f of flags) console.log(f);
  }
  // 8. override peek — a stored user answer prices a line invisibly to the
  // pcs/canonical read above; check claim metadata for the starred claims.
  console.log("\n--- metadata override peek (starred claims) ---");
  const starIds = ["4e059cb9-44b4-4f7f-8958-91e8053225ff"];
  const { data: metaRows, error: e8 } = await sb.from("claims").select("id, metadata").in("id", starIds);
  if (e8) throw new Error("meta: " + e8.message);
  for (const c of metaRows ?? []) {
    const m = (c.metadata ?? {}) as Record<string, unknown>;
    console.log("claim", (c.id as string).slice(0, 8), "keys:", Object.keys(m).join(", "));
    for (const k of Object.keys(m)) {
      if (/override|costshare|cost_share|service|rate/i.test(k)) {
        console.log(`  ${k}: ${JSON.stringify(m[k]).slice(0, 500)}`);
      }
    }
  }
  // 9. secondary-match predictor — the engine can borrow a covered CATEGORY
  // sibling's cost share (S153). Dump the BlueSelect plan's priced rows +
  // candidate slugs' categories to predict whether the chip really renders.
  console.log("\n--- secondary-match predictor ---");
  const { data: cat, error: e9 } = await sb
    .from("service_catalog")
    .select("slug, category")
    .in("slug", ["allergy_injection", "physical_therapy"]);
  if (e9) throw new Error("cat: " + e9.message);
  for (const r of cat ?? []) console.log(`candidate ${r.slug} → category=${r.category}`);
  const bluePlanId = claims!.find((c) => c.id.startsWith("4e059cb9"))!.insurance_plan_id as string;
  const { data: blueRows, error: e10 } = await sb
    .from("plan_covered_services")
    .select("covered, in_copay, in_coinsurance, place_of_service, component, service_catalog!inner(slug, category)")
    .eq("insurance_plan_id", bluePlanId);
  if (e10) throw new Error("blue pcs: " + e10.message);
  console.log(`BlueSelect pcs rows: ${blueRows!.length}`);
  for (const r of blueRows ?? []) {
    const scRel = r.service_catalog as unknown as { slug: string; category: string | null } | null;
    console.log(
      `  ${scRel?.slug} [${scRel?.category}] covered=${r.covered} copay=${r.in_copay} coins=${r.in_coinsurance} pos=${r.place_of_service} comp=${r.component}`,
    );
  }
}
main().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
// appended: physical_therapy deep-dive (run with PROBE_PT=1)
if (process.env.PROBE_PT) {
  (async () => {
    const sb2 = createClient(url, key);
    const { data: pt, error: p1 } = await sb2
      .from("service_catalog")
      .select("id, slug, category, merged_into_id, deprecated_at")
      .eq("slug", "physical_therapy");
    if (p1) throw new Error(p1.message);
    console.log("physical_therapy catalog rows:", JSON.stringify(pt));
    const cats = Array.from(new Set((pt ?? []).map((r) => r.category).filter(Boolean)));
    if (cats.length) {
      const { data: sibs, error: p2 } = await sb2
        .from("service_catalog")
        .select("slug, category")
        .in("category", cats as string[]);
      if (p2) throw new Error(p2.message);
      console.log("category siblings:", (sibs ?? []).map((s) => s.slug).join(", "));
    }
  })().catch((e) => { console.error("PT FAIL:", e.message); process.exit(1); });
}
// appended: duplicate-pair inspector (run with PROBE_PAIRS=1)
if (process.env.PROBE_PAIRS) {
  (async () => {
    const sb3 = createClient(url, key);
    const { data: anchor2 } = await sb3
      .from("claims").select("user_id")
      .gte("id", "4e059cb9-0000-0000-0000-000000000000")
      .lt("id", "4e059cb9-ffff-ffff-ffff-ffffffffffff").limit(1);
    const uid = anchor2![0].user_id as string;
    const { data: cs, error } = await sb3
      .from("claims")
      .select("id, created_at, date_of_service, total_billed, metadata")
      .eq("user_id", uid).is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    for (const c of cs ?? []) {
      const prov = ((c.metadata as { provider?: { name?: string } } | null)?.provider?.name ?? "").trim().toLowerCase();
      console.log(`${c.id} created=${c.created_at} dos=${c.date_of_service} total=${c.total_billed} provider="${prov}"`);
    }
  })().catch((e) => { console.error("PAIRS FAIL:", e.message); process.exit(1); });
}
// appended: letter-link inventory (run with PROBE_LETTERS=1)
if (process.env.PROBE_LETTERS) {
  (async () => {
    const sb4 = createClient(url, key);
    const { data: anchor3 } = await sb4
      .from("claims").select("user_id")
      .gte("id", "4e059cb9-0000-0000-0000-000000000000")
      .lt("id", "4e059cb9-ffff-ffff-ffff-ffffffffffff").limit(1);
    const uid2 = anchor3![0].user_id as string;
    const { data: ls, error } = await sb4
      .from("dispute_outcomes")
      .select("id, claim_id, dispute_type, status, created_at")
      .eq("user_id", uid2)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    for (const l of ls ?? []) {
      console.log(
        `letter ${(l.id as string).slice(0, 8)} full=${l.id} claim=${(l.claim_id as string | null)?.slice(0, 8) ?? "—"} type=${l.dispute_type} status=${l.status}`,
      );
    }
  })().catch((e) => { console.error("LETTERS FAIL:", e.message); process.exit(1); });
}
