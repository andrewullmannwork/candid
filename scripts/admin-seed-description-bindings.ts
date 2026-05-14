/**
 * scripts/admin-seed-description-bindings.ts — S74.6 §G (Session 89).
 *
 * Admin bootstrap CLI for seeding billing_code_identity rows from public
 * CMS / CDC / USPSTF / NUCC sources before MVP launch. Each seeded row
 * counts as 1 vote (NOT auto-authority) per Subplan §G governance — the
 * row lands in promotion_state='proposed' and needs 4 more user votes to
 * corroborate. If user votes converge on a different slug, the user-voted
 * slug wins.
 *
 * Usage:
 *   # Dry-run (default — no writes):
 *   npx tsx scripts/admin-seed-description-bindings.ts --input scripts/seeds/admin_description_bindings_v1.csv
 *
 *   # Apply:
 *   npx tsx scripts/admin-seed-description-bindings.ts --input scripts/seeds/admin_description_bindings_v1.csv --apply
 *
 * CSV columns (header row required):
 *   description_pattern, code, code_type, target_slug, source_label, basis
 *
 * Per-row behavior:
 *   1. Normalize description via `normalizeDescriptionSignature(description_pattern, code)`
 *   2. UPSERT into billing_code_identity keyed on
 *      `(billing_code, billing_code_type, description_signature)`:
 *      - On INSERT: promotion_state='proposed', service_slug=<target>, confidence=0.5,
 *        corroborator_sources=[{source: 'admin_seed_pre_launch', source_label, basis,
 *        recorded_at, vote_weight: 1}], distinct_user_count=1
 *      - On conflict (row already exists): append admin_seed source to
 *        corroborator_sources (idempotent — skips if already present).
 *   3. Validate target_slug against service_catalog before write (fails the
 *      row if slug is unknown; logs but continues so other rows still apply).
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { normalizeDescriptionSignature } from "../src/lib/parser/code-identity";

interface SeedRow {
  description_pattern: string;
  code: string;
  code_type: string;
  target_slug: string;
  source_label: string;
  basis: string;
}

interface RowResult {
  code: string;
  codeType: string;
  signature: string;
  targetSlug: string;
  action: "inserted" | "updated" | "skipped_already_seeded" | "error";
  identityId?: string;
  error?: string;
}

function parseArgs(): { input: string; apply: boolean } {
  const args = process.argv.slice(2);
  let input = "";
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) {
      input = args[i + 1];
      i++;
    } else if (args[i] === "--apply") {
      apply = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "Usage: npx tsx scripts/admin-seed-description-bindings.ts --input <path> [--apply]",
      );
      process.exit(0);
    }
  }
  if (!input) {
    console.error("--input <path> is required");
    process.exit(1);
  }
  return { input: resolve(input), apply };
}

function parseCsv(raw: string): SeedRow[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const requiredCols = [
    "description_pattern",
    "code",
    "code_type",
    "target_slug",
    "source_label",
    "basis",
  ];
  for (const col of requiredCols) {
    if (!header.includes(col)) {
      throw new Error(`CSV missing required column: ${col}`);
    }
  }
  const rows: SeedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length === 0 || cells.every((c) => c.trim() === "")) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    rows.push({
      description_pattern: row.description_pattern,
      code: row.code,
      code_type: row.code_type,
      target_slug: row.target_slug,
      source_label: row.source_label,
      basis: row.basis,
    });
  }
  return rows;
}

// Minimal CSV line parser supporting double-quoted fields with embedded commas.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

async function main() {
  const { input, apply } = parseArgs();

  const raw = readFileSync(input, "utf-8");
  const rows = parseCsv(raw);

  console.log(
    `[admin-seed] loaded ${rows.length} rows from ${input}; mode=${apply ? "APPLY" : "DRY-RUN"}`,
  );

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required.",
    );
    process.exit(1);
  }
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  // Pre-fetch valid service_catalog slugs for validation.
  const { data: slugRows } = await supabase
    .from("service_catalog")
    .select("slug")
    .is("merged_into_id", null);
  const validSlugs = new Set((slugRows ?? []).map((r) => r.slug as string));

  const results: RowResult[] = [];
  const nowIso = new Date().toISOString();

  for (const row of rows) {
    const signature = normalizeDescriptionSignature(
      row.description_pattern,
      row.code,
    );
    const result: RowResult = {
      code: row.code,
      codeType: row.code_type,
      signature,
      targetSlug: row.target_slug,
      action: "error",
    };
    if (!signature) {
      result.error = "empty signature after normalization";
      results.push(result);
      continue;
    }
    if (!validSlugs.has(row.target_slug)) {
      result.error = `target_slug='${row.target_slug}' not in service_catalog`;
      results.push(result);
      continue;
    }

    if (!apply) {
      result.action = "inserted"; // dry-run optimistic — show what would happen
      results.push(result);
      continue;
    }

    // Look up existing row.
    const { data: existing } = await supabase
      .from("billing_code_identity")
      .select("id, corroborator_sources, distinct_user_count, service_slug")
      .eq("billing_code", row.code)
      .eq("billing_code_type", row.code_type)
      .eq("description_signature", signature)
      .maybeSingle();

    const sourceEntry = {
      source: "admin_seed_pre_launch",
      source_label: row.source_label,
      basis: row.basis,
      vote_weight: 1,
      recorded_at: nowIso,
      proposed_slug: row.target_slug,
      raw_description: row.description_pattern,
    };

    if (existing) {
      const sources = Array.isArray(existing.corroborator_sources)
        ? (existing.corroborator_sources as Record<string, unknown>[])
        : [];
      const alreadySeeded = sources.some(
        (s) =>
          s.source === "admin_seed_pre_launch" || s.source === "admin_seed",
      );
      if (alreadySeeded) {
        result.action = "skipped_already_seeded";
        result.identityId = existing.id as string;
        results.push(result);
        continue;
      }
      const nextSources = [...sources, sourceEntry];
      const nextCount = Number(existing.distinct_user_count ?? 0) + 1;
      // Only set service_slug when the row didn't already have one — admin
      // seeding shouldn't overwrite a user-voted slug.
      const updates: Record<string, unknown> = {
        corroborator_sources: nextSources,
        distinct_user_count: nextCount,
      };
      if (!existing.service_slug) updates.service_slug = row.target_slug;
      const { error: updErr } = await supabase
        .from("billing_code_identity")
        .update(updates)
        .eq("id", existing.id);
      if (updErr) {
        result.error = updErr.message;
      } else {
        result.action = "updated";
        result.identityId = existing.id as string;
      }
      results.push(result);
      continue;
    }

    // Fresh insert.
    const { data: inserted, error: insErr } = await supabase
      .from("billing_code_identity")
      .insert({
        billing_code: row.code,
        billing_code_type: row.code_type,
        description_signature: signature,
        description_examples: [row.description_pattern],
        service_slug: row.target_slug,
        promotion_state: "proposed",
        confidence: 0.5,
        distinct_user_count: 1,
        corroborator_sources: [sourceEntry],
      })
      .select("id")
      .maybeSingle();
    if (insErr) {
      result.error = insErr.message;
    } else if (inserted) {
      result.action = "inserted";
      result.identityId = inserted.id as string;
    }
    results.push(result);
  }

  // Summary table.
  const inserted = results.filter((r) => r.action === "inserted").length;
  const updated = results.filter((r) => r.action === "updated").length;
  const skipped = results.filter((r) => r.action === "skipped_already_seeded").length;
  const errored = results.filter((r) => r.action === "error").length;
  console.log("[admin-seed] summary:");
  console.log(`  inserted: ${inserted}`);
  console.log(`  updated:  ${updated}`);
  console.log(`  skipped:  ${skipped} (already seeded)`);
  console.log(`  errored:  ${errored}`);

  if (errored > 0) {
    console.log("\n[admin-seed] errors:");
    for (const r of results.filter((r) => r.action === "error")) {
      console.log(
        `  ${r.code} (${r.codeType}) "${r.signature}" → ${r.targetSlug}: ${r.error}`,
      );
    }
  }

  if (!apply) {
    console.log(
      "\n[admin-seed] DRY-RUN — no DB writes performed. Re-run with --apply to actually seed.",
    );
  }
}

main().catch((err) => {
  console.error("[admin-seed] fatal", err);
  process.exit(1);
});
