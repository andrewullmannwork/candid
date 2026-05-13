/**
 * One-time backfill: link pre-S74.5 claim_line_items to billing_code_identity.
 *
 * S74.5 D10 (Session 83).
 *
 * For each claim_line_items row where billing_code_identity_id IS NULL
 * AND billing_code IS NOT NULL AND description IS NOT NULL:
 *   1. Compute normalized description_signature
 *   2. Look up (code, code_type, signature) in billing_code_identity
 *      - Exact match → link row's billing_code_identity_id; if row has no
 *        service_slug yet and identity has one, also set service_slug
 *      - No match → propose new signature row (no slug; goes to admin queue
 *        for Pattern P-9 review) + link
 *   3. Idempotent — re-running only touches still-null rows.
 *
 * Skips Haiku similarity matching by design: backfill could create thousands
 * of similar signatures for legacy data. Admin queue handles merging via D8
 * (or future bulk dedup). Exact-match + propose is the safe baseline.
 *
 * Run:
 *   npx tsx scripts/backfill-billing-code-identity.ts             # dry-run, default
 *   npx tsx scripts/backfill-billing-code-identity.ts --apply     # actually write
 *   npx tsx scripts/backfill-billing-code-identity.ts --apply --limit 500
 *   npx tsx scripts/backfill-billing-code-identity.ts --apply --batch 50
 *
 * Loads credentials from .env.local at the candid repo root (same pattern as
 * scripts/seed-zero-cost-share-codes.ts).
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { normalizeDescriptionSignature } from "../src/lib/parser/code-identity";
import { inferProcedureCodeType } from "../src/lib/billing/code-type-inference";
import type { ProcedureCodeType } from "../src/lib/billing/types";

config({ path: resolve(__dirname, "../.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface Args {
  apply: boolean;
  limit: number;
  batch: number;
}

function parseArgs(): Args {
  const apply = process.argv.includes("--apply");
  const limitIdx = process.argv.indexOf("--limit");
  const batchIdx = process.argv.indexOf("--batch");
  return {
    apply,
    limit:
      limitIdx > -1 && process.argv[limitIdx + 1]
        ? Number(process.argv[limitIdx + 1])
        : 5000,
    batch:
      batchIdx > -1 && process.argv[batchIdx + 1]
        ? Number(process.argv[batchIdx + 1])
        : 100,
  };
}

interface LineItem {
  id: string;
  billing_code: string;
  billing_code_type: string | null;
  service_slug: string | null;
  description: string | null;
}

interface IdentityRow {
  id: string;
  service_slug: string | null;
  description_examples: string[] | null;
}

interface Stats {
  processed: number;
  exactMatches: number;
  proposedNew: number;
  linkedExisting: number;
  slugBackfilled: number;
  skippedNoSignature: number;
  skippedNoCodeType: number;
  errors: number;
}

async function fetchBatch(offset: number, batch: number): Promise<LineItem[]> {
  const { data, error } = await supabase
    .from("claim_line_items")
    .select("id, billing_code, billing_code_type, service_slug, description")
    .is("billing_code_identity_id", null)
    .not("billing_code", "is", null)
    .not("description", "is", null)
    .order("created_at", { ascending: true })
    .range(offset, offset + batch - 1);
  if (error) {
    console.error("[backfill] fetchBatch error:", error.message);
    return [];
  }
  return (data ?? []) as LineItem[];
}

async function lookupExact(
  code: string,
  codeType: ProcedureCodeType,
  signature: string,
): Promise<IdentityRow | null> {
  const { data, error } = await supabase
    .from("billing_code_identity")
    .select("id, service_slug, description_examples")
    .eq("billing_code", code)
    .eq("billing_code_type", codeType)
    .eq("description_signature", signature)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[backfill] lookupExact error:", error.message);
    return null;
  }
  return data as IdentityRow | null;
}

async function appendExampleIfNew(
  identity: IdentityRow,
  rawDescription: string,
  apply: boolean,
): Promise<void> {
  const existing = identity.description_examples ?? [];
  if (existing.includes(rawDescription)) return;
  if (!apply) return;
  const next = [rawDescription, ...existing].slice(0, 5);
  await supabase
    .from("billing_code_identity")
    .update({ description_examples: next })
    .eq("id", identity.id);
}

async function proposeNew(opts: {
  code: string;
  codeType: ProcedureCodeType;
  signature: string;
  rawDescription: string;
  apply: boolean;
}): Promise<IdentityRow | null> {
  if (!opts.apply) {
    // Dry-run: return synthetic identity row so the script reports counts
    return {
      id: "dry-run-uuid",
      service_slug: null,
      description_examples: [opts.rawDescription],
    };
  }
  const { data, error } = await supabase
    .from("billing_code_identity")
    .insert({
      billing_code: opts.code,
      billing_code_type: opts.codeType,
      description_signature: opts.signature,
      description_examples: [opts.rawDescription],
      service_slug: null,
      promotion_state: "proposed",
      confidence: 0.5,
      distinct_user_count: 0,
      proposed_by_user_id: null,
    })
    .select("id, service_slug, description_examples")
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      // Race-lost: someone else inserted the same composite key; re-query.
      return lookupExact(opts.code, opts.codeType, opts.signature);
    }
    console.warn("[backfill] proposeNew error:", error.message);
    return null;
  }
  return data as IdentityRow | null;
}

async function linkLineItem(
  lineItemId: string,
  identityId: string,
  slugToSet: string | null,
  apply: boolean,
): Promise<boolean> {
  if (!apply) return true;
  const updates: Record<string, unknown> = { billing_code_identity_id: identityId };
  if (slugToSet) updates.service_slug = slugToSet;
  const { error } = await supabase
    .from("claim_line_items")
    .update(updates)
    .eq("id", lineItemId);
  if (error) {
    console.warn(`[backfill] linkLineItem error for ${lineItemId}:`, error.message);
    return false;
  }
  return true;
}

async function processOne(li: LineItem, apply: boolean, stats: Stats): Promise<void> {
  const code = li.billing_code;
  const inferredType = (li.billing_code_type as ProcedureCodeType | null) ?? null;
  const codeType =
    inferredType && isValidCodeType(inferredType)
      ? inferredType
      : (inferProcedureCodeType(code) ?? null);
  if (!codeType) {
    stats.skippedNoCodeType += 1;
    return;
  }

  const signature = normalizeDescriptionSignature(li.description ?? "", code);
  if (!signature) {
    stats.skippedNoSignature += 1;
    return;
  }

  const existing = await lookupExact(code, codeType, signature);
  if (existing) {
    stats.exactMatches += 1;
    await appendExampleIfNew(existing, li.description ?? "", apply);
    // If line item has no slug but identity has one, backfill the slug.
    const slugToSet =
      li.service_slug == null && existing.service_slug ? existing.service_slug : null;
    if (slugToSet) stats.slugBackfilled += 1;
    const ok = await linkLineItem(li.id, existing.id, slugToSet, apply);
    if (ok) stats.linkedExisting += 1;
    else stats.errors += 1;
    return;
  }

  const proposed = await proposeNew({
    code,
    codeType,
    signature,
    rawDescription: li.description ?? "",
    apply,
  });
  if (!proposed) {
    stats.errors += 1;
    return;
  }
  stats.proposedNew += 1;
  const ok = await linkLineItem(li.id, proposed.id, null, apply);
  if (ok) stats.linkedExisting += 1;
  else stats.errors += 1;
}

function isValidCodeType(s: string): s is ProcedureCodeType {
  return ["CPT", "HCPCS_L2", "G_CODE", "CAT_II", "REV", "NDC", "DRG"].includes(s);
}

async function main() {
  const args = parseArgs();
  console.log(
    `[backfill] mode=${args.apply ? "APPLY" : "DRY-RUN"} limit=${args.limit} batch=${args.batch}`,
  );

  const stats: Stats = {
    processed: 0,
    exactMatches: 0,
    proposedNew: 0,
    linkedExisting: 0,
    slugBackfilled: 0,
    skippedNoSignature: 0,
    skippedNoCodeType: 0,
    errors: 0,
  };

  // Note: when --apply, fetchBatch with offset=0 each iteration is correct
  // because each successful link removes the row from the "where
  // billing_code_identity_id IS NULL" filter — the next batch starts fresh
  // at offset 0 on the remaining unlinked rows. For dry-run, we use offset
  // to avoid an infinite loop on the same rows.
  let offset = 0;
  while (stats.processed < args.limit) {
    const remaining = args.limit - stats.processed;
    const fetchSize = Math.min(args.batch, remaining);
    const fetchOffset = args.apply ? 0 : offset;
    const batch = await fetchBatch(fetchOffset, fetchSize);
    if (batch.length === 0) break;

    for (const li of batch) {
      try {
        await processOne(li, args.apply, stats);
        stats.processed += 1;
      } catch (err) {
        console.error(`[backfill] processOne threw on ${li.id}:`, err);
        stats.errors += 1;
        stats.processed += 1;
      }
    }

    offset += batch.length;
    console.log(
      `[backfill] progress: processed=${stats.processed} exactHits=${stats.exactMatches} proposed=${stats.proposedNew} errors=${stats.errors}`,
    );
  }

  console.log("");
  console.log("──────── Summary ────────");
  console.log(`mode               ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`processed          ${stats.processed}`);
  console.log(`exact matches      ${stats.exactMatches}`);
  console.log(`proposed new       ${stats.proposedNew}`);
  console.log(`linked rows        ${stats.linkedExisting}`);
  console.log(`slugs backfilled   ${stats.slugBackfilled}`);
  console.log(`skipped (no sig)   ${stats.skippedNoSignature}`);
  console.log(`skipped (no type)  ${stats.skippedNoCodeType}`);
  console.log(`errors             ${stats.errors}`);
  console.log("─────────────────────────");

  if (!args.apply) {
    console.log("");
    console.log("[backfill] dry-run only — re-run with --apply to write");
  }

  process.exit(stats.errors > 0 ? 1 : 0);
}

void main();
