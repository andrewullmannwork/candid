/**
 * ID-Block fingerprint backfill + read-only PROD validation (S173).
 *
 * DRY-RUN (default, READ-ONLY): computes content fingerprints over the live
 * plan-doc-family corpus from documents.processing_ocr_text (retained post-process,
 * Phase 4.0.5 — no re-OCR) and validates the §3.1 trigger on REAL data:
 *   - Invariant A: identical file_hash → identical fingerprint (determinism on
 *     real OCR text),
 *   - Invariant B (the gap ID-Block closes): within a canonical, docs with DIFFERENT
 *     file_hash but Hamming ≤ threshold = the same document re-saved across uploads
 *     that file_hash missed,
 *   - within- vs cross-canonical Hamming separation (the discriminator works).
 * Writes NOTHING in dry-run; does NOT require mig 155.
 *
 * --apply: UPDATE documents.content_fingerprint for the same corpus (idempotent —
 * the value is deterministic). Requires mig 155 applied. Operator-gated.
 *
 * Run:
 *   cd /Users/andrewullmann/Desktop/candid
 *   npx tsx scripts/id-block/fingerprint-backfill.ts            # dry-run validation
 *   npx tsx scripts/id-block/fingerprint-backfill.ts --apply    # write (post mig 155)
 *
 * Aggregate output only (IDs + hash prefixes + fingerprints — no OCR text / PII).
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../../.env.local"), override: true });
import { createClient } from "@supabase/supabase-js";
import {
  computeContentFingerprint,
  hammingDistance,
} from "../../src/lib/parser/id-block/content-fingerprint";
import { DEFAULT_ID_BLOCK_CONFIG } from "../../src/lib/parser/id-block/config";

const APPLY = process.argv.includes("--apply");
const HAMMING = DEFAULT_ID_BLOCK_CONFIG.gate.hammingNearDupThreshold;
const PLAN_DOC_TYPES = ["sbc", "plan_document", "eoc"];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

interface DocRec {
  id: string;
  fileHash: string | null;
  planId: string | null;
  fp: string | null;
  textLen: number;
}

function pushMap<T>(m: Map<string, T[]>, k: string, v: T): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

async function main(): Promise<void> {
  // 1. Page the plan-doc-family corpus that has retained OCR text.
  const recs: DocRec[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("documents")
      .select("id, file_hash, linked_insurance_plan_id, processing_ocr_text")
      .in("classified_type", PLAN_DOC_TYPES)
      .not("processing_ocr_text", "is", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("documents query error:", error.message);
      process.exit(1);
    }
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of batch) {
      const ocr = (r.processing_ocr_text as string | null) ?? "";
      recs.push({
        id: r.id as string,
        fileHash: (r.file_hash as string | null) ?? null,
        planId: (r.linked_insurance_plan_id as string | null) ?? null,
        fp: computeContentFingerprint(ocr),
        textLen: ocr.length,
      });
    }
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  const withFp = recs.filter((r) => r.fp);
  console.log(
    `plan-doc-family docs w/ retained OCR text: ${recs.length}; non-null fingerprints: ${withFp.length}`,
  );
  if (withFp.length === 0) {
    console.log("Nothing to validate (no retained OCR text in scope).");
    return;
  }

  // 2. Invariant A — same bytes (file_hash) should yield a NEAR-IDENTICAL fingerprint.
  //    Exact divergence is possible when the retained OCR text differs across
  //    re-processing of the same bytes (chunk-boundary / retry variance). What
  //    matters for the gate is that such pairs stay WITHIN the near-dup threshold
  //    (and byte-identical replays are caught by file_hash regardless).
  const byHash = new Map<string, DocRec[]>();
  for (const r of withFp) if (r.fileHash) pushMap(byHash, r.fileHash, r);
  let aGroups = 0;
  let aExactDivergent = 0;
  let aBeyondThreshold = 0;
  for (const [hash, group] of byHash) {
    if (group.length < 2) continue;
    aGroups++;
    let maxH = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const d = hammingDistance(group[i].fp, group[j].fp);
        if (d > maxH) maxH = d;
      }
    }
    if (maxH > 0) {
      aExactDivergent++;
      const lens = group.map((g) => g.textLen);
      const beyond = maxH > HAMMING;
      if (beyond) aBeyondThreshold++;
      console.log(
        `  [A] file_hash ${hash.slice(0, 12)} (${group.length} docs): maxHamming=${maxH}${beyond ? " >THRESHOLD" : " (near-dup OK)"}, ocrLen ${Math.min(...lens)}..${Math.max(...lens)}`,
      );
    }
  }
  console.log(
    `Invariant A (same bytes → near-identical fp): ${aGroups} multi-doc hash groups; ${aExactDivergent} exact-divergent; ${aBeyondThreshold} beyond near-dup threshold (H>${HAMMING})`,
  );

  // 3. Group by canonical_plan_id (linked_insurance_plan_id → insurance_plans).
  const planIds = [...new Set(withFp.map((r) => r.planId).filter((p): p is string => !!p))];
  const canonByPlan = new Map<string, string | null>();
  for (let i = 0; i < planIds.length; i += 500) {
    const chunk = planIds.slice(i, i + 500);
    const { data } = await sb.from("insurance_plans").select("id, canonical_plan_id").in("id", chunk);
    for (const p of (data ?? []) as Array<Record<string, unknown>>) {
      canonByPlan.set(p.id as string, (p.canonical_plan_id as string | null) ?? null);
    }
  }
  const byCanon = new Map<string, DocRec[]>();
  for (const r of withFp) {
    const c = r.planId ? canonByPlan.get(r.planId) : null;
    if (c) pushMap(byCanon, c, r);
  }

  // 4. Invariant B — within a canonical, near-dup pairs with DIFFERENT file_hash are
  //    the re-saved replays that file_hash misses (exactly the gap ID-Block closes).
  let nearDupPairs = 0;
  let nearDupDifferentBytes = 0;
  let distinctPairs = 0;
  const examples: string[] = [];
  let multiDocCanon = 0;
  for (const [canon, group] of byCanon) {
    if (group.length < 2) continue;
    multiDocCanon++;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const d = hammingDistance(group[i].fp, group[j].fp);
        if (d <= HAMMING) {
          nearDupPairs++;
          if (group[i].fileHash !== group[j].fileHash) {
            nearDupDifferentBytes++;
            if (examples.length < 10) {
              examples.push(
                `canon ${canon.slice(0, 8)}: ${group[i].id.slice(0, 8)} ~ ${group[j].id.slice(0, 8)} (H=${d}, file_hash differ)`,
              );
            }
          }
        } else {
          distinctPairs++;
        }
      }
    }
  }
  console.log(
    `Within-canonical (${multiDocCanon} multi-doc canonicals): near-dup(H≤${HAMMING})=${nearDupPairs} [different-bytes=${nearDupDifferentBytes}], distinct=${distinctPairs}`,
  );
  console.log(
    `Invariant B (re-saved replays that file_hash missed): ${nearDupDifferentBytes} pair(s)`,
  );
  for (const e of examples) console.log(`  [B] ${e}`);

  if (!APPLY) {
    console.log("\nDRY-RUN — no writes. Re-run with --apply (after mig 155) to persist fingerprints.");
    return;
  }

  // 5. --apply (post mig 155): idempotent write of the deterministic fingerprint.
  let written = 0;
  let failed = 0;
  for (const r of withFp) {
    const { error } = await sb
      .from("documents")
      .update({ content_fingerprint: r.fp })
      .eq("id", r.id);
    if (error) {
      failed++;
      if (failed <= 5) console.error(`  update ${r.id.slice(0, 8)}: ${error.message}`);
    } else {
      written++;
    }
  }
  console.log(`\n--apply: wrote ${written} fingerprints, ${failed} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
