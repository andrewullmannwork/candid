/**
 * scripts/phase-1-fixture-dedup-check.ts — S90 Phase 1 pre-upload check.
 *
 * Compares SHA-256 hashes of Andrew's local Downloads PDFs against PROD
 * documents.file_hash to identify which would trigger file-hash dedup
 * (Phase 4A.9 scenario) vs which would parse fresh (Phase 1 scenarios).
 *
 * Usage:
 *   npx tsx scripts/phase-1-fixture-dedup-check.ts
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// SHA-256 hashes of Andrew's local Downloads PDFs, computed via `shasum -a 256`.
const LOCAL_HASHES: Record<string, string> = {
  "EOB1.pdf": "0f9a894f086cc8842548b07f5f7b1f848004fb72ffba7ca32dd78ac42b924774",
  "EOB2.pdf": "defb17121b6d7ba7849f7e88c12fa454c2e8e512cdfb8978b2182e71ba0362ad",
  "EOB3.pdf": "892f6b76a26c97c8d0db1868ddff19b2fec41d5cb4f1c68b19e7da778e3e1c60",
  "EOB4.pdf": "30b6bb6274eeec0f74e1d50b422013c8d4d4bbe1fe1eadfd11f223208edea332",
  "EOB5.pdf": "e20096c58efba1bc40aa619f36318615b6bacf69b8b484c6987ef981d3d62ce0",
  "cignaEOB.pdf": "e64c695716af15726c7761edb6a4f413b580acef94e870e7581eb2923d4b5b51",
  "6_2.pdf": "bdc16a291a414e2c86cec5d3f6f06e329991e3042275337b2f1f015521c61923",
  "current_cigna_plan.pdf": "91f425a6e97b26f374242e14bafd14862f94f34f98df76be19df3c63ee3dd18f",
  "Cigna Plan Benefits.pdf": "c1c35da7377137ae36f741714512fdd45e5a3bb76d7691c32c4bd89bd43aac5a",
  "contents-2.pdf": "d63cb86a9bbf98b849b46cddd9f9f4082dece1fbdc8a2df07b6093d6d7251e6f",
  "contents-3.pdf": "f87a615fc00e0af21873fbe7ef5eb0bd80861434460494d5da7b6f688979b8fe",
  "contents-4.pdf": "ed52d718ee699ba528b8bb90320cd9303a7a171a69174524cefe8b08f2d059a8",
  "contents-5.pdf": "bdc7110572af530703be05ed58f65ffc134a17fefaa69f45068a27a929de8147",
  "contents-6.pdf": "b78c18713b007b2fa8e3c9a6aff45584d4d0fa31cfb3a655cb2bc0abf7a9970d",
  "contents-7.pdf": "8ccd21fe7697980a94437a7e585f8a1fafda765f236e54b9fef963d8fdf3dcdd",
};

async function main() {
  console.log(`Checking ${Object.keys(LOCAL_HASHES).length} local hashes against PROD documents.file_hash\n`);
  const hashes = Object.values(LOCAL_HASHES);
  const { data, error } = await sb
    .from("documents")
    .select("id, file_hash, user_id, file_name, status, processing_step, classified_type, created_at")
    .in("file_hash", hashes);
  if (error) {
    console.error(`Query failed: ${error.message}`);
    process.exit(1);
  }

  const matchByHash = new Map<string, Array<Record<string, unknown>>>();
  for (const row of (data || []) as Array<Record<string, unknown>>) {
    const h = row.file_hash as string;
    if (!matchByHash.has(h)) matchByHash.set(h, []);
    matchByHash.get(h)!.push(row);
  }

  console.log("FILE                           STATUS          PROD MATCH DETAILS");
  console.log("-".repeat(120));
  let freshCount = 0;
  let dedupCount = 0;
  for (const [filename, hash] of Object.entries(LOCAL_HASHES)) {
    const matches = matchByHash.get(hash) || [];
    if (matches.length === 0) {
      console.log(`${filename.padEnd(30)} FRESH`);
      freshCount++;
    } else {
      const m = matches[0];
      console.log(
        `${filename.padEnd(30)} IN PROD (dedup) ` +
          `doc=${m.id} type=${m.classified_type ?? "—"} ` +
          `status=${m.status} step=${m.processing_step ?? "—"} created=${(m.created_at as string).slice(0, 10)}`,
      );
      if (matches.length > 1) {
        for (const extra of matches.slice(1)) {
          console.log(
            `${" ".padEnd(30)}              (extra match) doc=${extra.id} created=${(extra.created_at as string).slice(0, 10)}`,
          );
        }
      }
      dedupCount++;
    }
  }
  console.log("-".repeat(120));
  console.log(`\nSummary: ${freshCount} FRESH (parse on upload) | ${dedupCount} IN PROD (file-hash dedup on upload)`);
}

main().catch((e) => {
  console.error("Fixture dedup check crashed:", e);
  process.exit(1);
});
