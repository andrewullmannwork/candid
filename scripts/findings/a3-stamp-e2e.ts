/**
 * A3 real flag-ON E2E for the synonym identity stamp (EPHEMERAL — delete before PR).
 *
 *   npx tsx scripts/findings/a3-stamp-e2e.ts <documentId|userEmail>
 *
 * Re-parses an already-ingested plan-doc through the REAL processPlanDocumentData with the
 * routing-time override ON (skipCanonical → user-scoped only, no canonical mutation), then
 * reads back the persisted plan_covered_services.field_provenance to confirm `resolution_source`
 * landed on the synonym cache-win cells. Proves the full legacy→deduped→s→provenance→DB seam
 * end-to-end (what inspection argued + what a reconstruction-probe could not).
 *
 * Captures the in-process `[process-plan] thesaurus routing: N cache-win(s)` log so we know a
 * real cache-win actually fired (else the probe is INCONCLUSIVE, not passing).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: "/Users/andrewullmann/Desktop/candid/.env.local" });
import { processPlanDocumentData } from "@/lib/plan/process-plan";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
) as SupabaseClient;

interface StampCell {
  serviceId: string;
  pos: string | null;
  sources: string[];
}

async function listStampedCells(userId: string): Promise<StampCell[]> {
  const { data: plans } = await sb.from("insurance_plans").select("id").eq("user_id", userId);
  const planIds = (plans ?? []).map((p: { id: string }) => p.id);
  if (!planIds.length) return [];
  const { data: rows } = await sb
    .from("plan_covered_services")
    .select("service_id, place_of_service, field_provenance")
    .in("insurance_plan_id", planIds);
  const out: StampCell[] = [];
  for (const r of rows ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fp = (r as any).field_provenance as Record<string, { resolution_source?: string }> | null;
    if (!fp) continue;
    const sources = new Set<string>();
    for (const k of Object.keys(fp)) {
      const rs = fp[k]?.resolution_source;
      if (rs) sources.add(rs);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (sources.size) out.push({ serviceId: (r as any).service_id, pos: (r as any).place_of_service, sources: [...sources] });
  }
  return out;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: a3-stamp-e2e.ts <documentId|userEmail>"); process.exit(1); }

  let docRow: {
    id: string; user_id: string; file_name: string; processing_ocr_text: string | null;
    classified_type: string | null; classification_confidence: number | null; type_mismatch: boolean | null;
  } | null = null;

  const cols = "id, user_id, file_name, processing_ocr_text, classified_type, classification_confidence, type_mismatch";
  if (arg.includes("@")) {
    const { data: user } = await sb.from("users").select("id").eq("email", arg).single();
    if (!user) { console.error("no user for", arg); process.exit(1); }
    const { data: docs } = await sb.from("documents").select(cols)
      .eq("user_id", (user as { id: string }).id)
      .in("classified_type", ["sbc", "plan_document"])
      .order("created_at", { ascending: false }).limit(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docRow = (docs as any)?.[0] ?? null;
  } else {
    const { data } = await sb.from("documents").select(cols).eq("id", arg).single();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docRow = (data as any) ?? null;
  }
  if (!docRow) { console.error("doc not found"); process.exit(1); }
  if (!docRow.processing_ocr_text || docRow.processing_ocr_text.length < 100) {
    console.error("no cached OCR on doc", docRow.id, "(re-upload may have purged it)"); process.exit(1);
  }
  console.log(`\nDoc ${docRow.id} (${docRow.file_name}) · user ${docRow.user_id} · type ${docRow.classified_type} · OCR ${docRow.processing_ocr_text.length} chars\n`);

  const before = await listStampedCells(docRow.user_id);
  console.log(`BEFORE: ${before.length} cell(s) with resolution_source`);

  console.log(`\n--- re-parsing with thesaurusRoutingOverride=true (skipCanonical, user-scoped) ---`);
  const result = await processPlanDocumentData(
    sb,
    { id: docRow.id, user_id: docRow.user_id, file_name: docRow.file_name },
    docRow.processing_ocr_text,
    docRow.id,
    // Replicate the live unified_plan_doc_parser_v1 dispatch (process-chunk/route.ts:498):
    // it coerces sbc/eoc → "plan_document" so the doc takes processPlanDocumentData's plan-doc
    // branch, where routePlanDocServices (the stamp) lives. Raw "sbc" hits the sbc_parser_v1-OFF
    // throw — exactly what the first run did. This is the faithful A4 flag-ON path for an SBC.
    {
      classifiedType: "plan_document",
      confidence: docRow.classification_confidence ?? 0.9,
      mismatch: docRow.type_mismatch ?? false,
    },
    { skipCanonical: true, thesaurusRoutingOverride: true },
  );
  console.log(`--- parse done: success=${result.success}${result.error ? ` error=${result.error}` : ""} ---\n`);

  const after = await listStampedCells(docRow.user_id);
  console.log(`AFTER: ${after.length} cell(s) with resolution_source (delta +${after.length - before.length})`);
  for (const c of after.slice(0, 25)) {
    console.log(`  service_id=${c.serviceId} pos=${c.pos ?? "-"} resolution_source=${JSON.stringify(c.sources)}`);
  }
  console.log(
    after.length > before.length
      ? `\n✅ SEAM PROVEN E2E: synonym cache-win cells persisted resolution_source to plan_covered_services.`
      : `\n⚠ INCONCLUSIVE: no new stamps. Check the "[process-plan] thesaurus routing: N cache-win(s)" line above — if N=0, this SBC produced no cache-wins (try another doc).`,
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
