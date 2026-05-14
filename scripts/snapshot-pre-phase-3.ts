/**
 * scripts/snapshot-pre-phase-3.ts — S90 pre-test JSON snapshot.
 *
 * Read-only. Dumps the 3 tables most at risk of cross-USER mutation during
 * Phase 3 + Phase 4D + Phase 4E testing to timestamped JSON files in
 * scripts/snapshots/. Free alternative to Supabase Pro's backup feature for
 * the targeted scope the Subplan §5 #8 reversibility note actually requires.
 *
 * Tables captured (full SELECT *, no row filter):
 *   - billing_code_identity   — promotion state + corroborator_sources;
 *                                Phase 3.1 + Phase 4D backfill mutates these
 *   - claim_line_items        — service_slug + audit_status; Phase 3
 *                                apply_promotion_event retroactively UPDATEs
 *                                these cross-USER
 *   - dispute_outcomes        — Phase 4E recoding writeback writes here
 *
 * Output layout:
 *   scripts/snapshots/snapshot-<ISO>/billing_code_identity.json
 *   scripts/snapshots/snapshot-<ISO>/claim_line_items.json
 *   scripts/snapshots/snapshot-<ISO>/dispute_outcomes.json
 *   scripts/snapshots/snapshot-<ISO>/manifest.json    (row counts + timestamps)
 *
 * Restore pattern (NOT automated — inspect diff first):
 *   1. Identify mutated rows: query current state, compare against snapshot JSON.
 *   2. Hand-write UPSERT SQL with the snapshot values for the affected primary keys.
 *   3. Run in Supabase Studio SQL Editor.
 *
 * Usage:
 *   npx tsx scripts/snapshot-pre-phase-3.ts
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env.local"), override: true });

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "fs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE env. Aborting.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TABLES = [
  "billing_code_identity",
  "claim_line_items",
  "dispute_outcomes",
] as const;

async function fetchAll(table: string): Promise<unknown[]> {
  // PostgREST default page size is 1000; supabase-js handles paging via
  // .range() but a single .select() returns up to that limit. Our tables here
  // are well under that scale (PROD has 55 billing_code_identity, <50
  // claim_line_items, ~0 dispute_outcomes). Plain select is sufficient.
  const { data, error } = await sb.from(table).select("*");
  if (error) {
    throw new Error(`${table}: ${error.message}`);
  }
  if (data && data.length >= 1000) {
    console.warn(
      `⚠️  ${table} returned >=1000 rows — possible pagination needed. Verify.`,
    );
  }
  return data || [];
}

async function main() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(__dirname, "snapshots", `snapshot-${iso}`);
  mkdirSync(dir, { recursive: true });

  console.log(`Snapshot directory: ${dir}\n`);

  const manifest: Record<string, { rows: number; file: string }> = {};
  for (const table of TABLES) {
    const rows = await fetchAll(table);
    const file = `${dir}/${table}.json`;
    writeFileSync(file, JSON.stringify(rows, null, 2), "utf-8");
    manifest[table] = { rows: rows.length, file };
    console.log(`✅ ${table.padEnd(28)} ${String(rows.length).padStart(5)} rows  →  ${table}.json`);
  }

  const manifestFile = `${dir}/manifest.json`;
  writeFileSync(
    manifestFile,
    JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        supabase_url: SUPABASE_URL,
        tables: manifest,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\nManifest: ${manifestFile}`);
  console.log(`\nSnapshot complete. Restore pattern in script header comment.`);
}

main().catch((e) => {
  console.error("Snapshot crashed:", e);
  process.exit(1);
});
