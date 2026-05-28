import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false } },
);

async function main() {
  console.log("=== I4: claim_line_items schema ===");
  const { data: cli } = await sb.from("claim_line_items").select("*").limit(1);
  if (cli && cli.length > 0) {
    console.log("columns:", Object.keys(cli[0]).sort().join(", "));
    console.log("\nsample row keys+types:");
    for (const [k, v] of Object.entries(cli[0]).sort()) {
      const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      const preview = v === null ? "null" : typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60);
      console.log(`  ${k.padEnd(40)} ${t.padEnd(10)} ${preview}`);
    }
  } else {
    console.log("claim_line_items returned 0 rows");
  }

  const { count: cliCount } = await sb.from("claim_line_items").select("id", { count: "exact", head: true });
  console.log("\nclaim_line_items total rows:", cliCount);

  console.log("\n\n=== I5: parse_cost_events.metadata payload ===");
  const { data: pce } = await sb.from("parse_cost_events").select("*").limit(5);
  if (pce && pce.length > 0) {
    console.log("parse_cost_events columns:", Object.keys(pce[0]).sort().join(", "));
    console.log("\nsample 5 rows (metadata field highlighted):");
    for (let i = 0; i < pce.length; i++) {
      const r = pce[i] as Record<string, unknown>;
      console.log(`\n--- Row ${i + 1} ---`);
      console.log("  parser_kind:", r.parser_kind);
      console.log("  cost_source:", r.cost_source);
      console.log("  document_id:", r.document_id);
      console.log("  metadata    :", JSON.stringify(r.metadata, null, 2));
    }
  } else {
    console.log("parse_cost_events returned 0 rows");
  }

  const { count: pceCount } = await sb.from("parse_cost_events").select("id", { count: "exact", head: true });
  console.log("\nparse_cost_events total rows:", pceCount);

  // diverse sample across parser_kind
  console.log("\nDiverse sample across parser_kind:");
  const parserKinds = ["plan_doc", "sbc", "eoc", "bill", "reparse_field", "reparse_field_batch", "admin_candidate_match", "auto_reparse"];
  for (const kind of parserKinds) {
    const { data: kindSample } = await sb.from("parse_cost_events").select("metadata").eq("parser_kind", kind).limit(1);
    if (kindSample && kindSample.length > 0) {
      const md = (kindSample[0] as { metadata: unknown }).metadata;
      console.log(`\n  parser_kind=${kind}:`);
      console.log("    metadata:", JSON.stringify(md, null, 4).split("\n").map(l => "      " + l).join("\n"));
    } else {
      console.log(`\n  parser_kind=${kind}: no rows`);
    }
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
