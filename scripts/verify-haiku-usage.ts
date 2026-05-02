import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

config({ path: "/Users/andrewullmann/Desktop/candid/.env.local", override: true });

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("ANTHROPIC_API_KEY: NOT SET");
    process.exit(1);
  }
  console.log("ANTHROPIC_API_KEY prefix:", apiKey.slice(0, 12) + "...");

  // Live API test
  const client = new Anthropic({ apiKey, timeout: 30000 });
  try {
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: "Reply with just the JSON: {\"ok\": true}" }],
    });
    console.log("LIVE API CALL OK");
    console.log("  model:", r.model);
    console.log("  usage:", JSON.stringify(r.usage));
  } catch (err) {
    console.log("LIVE API CALL FAILED:", err instanceof Error ? err.message : String(err));
  }

  // Pull harness records
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await sb
    .from("parse_audit_runs")
    .select("run_id, fixture_id, cost_usd, haiku_tokens_input, haiku_tokens_output, haiku_cache_read_tokens, parse_duration_ms")
    .like("run_id", "session_52_phase31a1%")
    .order("created_at", { ascending: false });
  if (error) {
    console.log("Supabase err:", error.message);
    return;
  }
  console.log("\nHarness records (parse_audit_runs):");
  console.log("run_id".padEnd(54) + " | " + "fixture".padEnd(40) + " | " + "cost".padStart(8) + " | " + "in_tok".padStart(9) + " | " + "out_tok".padStart(9) + " | " + "cache_read".padStart(11) + " | " + "ms".padStart(8));
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheRead = 0;
  for (const r of data || []) {
    const cost = r.cost_usd ?? 0;
    const inTok = r.haiku_tokens_input ?? 0;
    const outTok = r.haiku_tokens_output ?? 0;
    const cacheRead = r.haiku_cache_read_tokens ?? 0;
    totalCost += cost;
    totalIn += inTok;
    totalOut += outTok;
    totalCacheRead += cacheRead;
    console.log(
      String(r.run_id || "").padEnd(54) +
        " | " +
        String(r.fixture_id || "").slice(0, 40).padEnd(40) +
        " | $" +
        cost.toFixed(4).padStart(7) +
        " | " +
        String(inTok).padStart(9) +
        " | " +
        String(outTok).padStart(9) +
        " | " +
        String(cacheRead).padStart(11) +
        " | " +
        String(r.parse_duration_ms ?? 0).padStart(8),
    );
  }
  console.log("\nTOTALS across all session_52 harness rows:");
  console.log(`  cost: $${totalCost.toFixed(4)}`);
  console.log(`  input tokens: ${totalIn.toLocaleString()}`);
  console.log(`  output tokens: ${totalOut.toLocaleString()}`);
  console.log(`  cache read tokens: ${totalCacheRead.toLocaleString()}`);
  console.log(`  total rows: ${data?.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
