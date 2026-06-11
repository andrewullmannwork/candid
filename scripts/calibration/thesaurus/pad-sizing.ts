/* Cache-pad sizing + generation (S187 Session A). READ-ONLY measurement; COMMITTED S187 (the
 * checked-in regen path for the pad constant — Ship Gate G6 is N/A-with-reason for the pad,
 * and THIS script is part of that evidence: re-sizing is a deliberate code change, run here).
 *
 * Measures REAL tokens (count_tokens API, claude-haiku-4-5-20251001) for every Haiku prompt
 * variant the shared client sends on the EOC + plan-doc parse paths, at the vocab=""/no-supplement
 * worst cases AND the live-DB variants (S93 active supplements from parser_prompt_versions).
 * Then sizes the shared pad so (smallest padded prompt) >= TARGET and prints the pad body for
 * src/lib/haiku-client/cache-pad.ts. Variants measured >= TARGET are reported PAD-NOT-NEEDED.
 *
 *   npx tsx scripts/calibration/thesaurus/pad-sizing.ts [--target 4300]
 */
import fs from "fs";
import { loadCalibEnv } from "../../lib/calib-env";
const env = loadCalibEnv([]);
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { buildMedicalNecessityPrompt } from "@/lib/eoc/haiku-prompts/medical-necessity";
import { buildCachePad } from "@/lib/haiku-client/cache-pad";

const MODEL = "claude-haiku-4-5-20251001";
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
  auth: { persistSession: false },
});

async function realTokens(text: string): Promise<number> {
  const r = await client.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
  return r.input_tokens;
}

/** Extract a module-private template-literal const from source (pure-static prompts only). */
function extractConst(file: string, name: string): string {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  if (m[1].includes("${")) throw new Error(`${name} in ${file} is NOT pure-static (has interpolation)`);
  return m[1].replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\\/g, "\\");
}

/** S93: live active supplement from parser_prompt_versions, falling back to the compile-time const. */
async function activeSupplement(promptFilePath: string, exportName: string, fallback: string): Promise<{ text: string; source: string }> {
  const { data } = await sb
    .from("parser_prompt_versions")
    .select("content")
    .eq("prompt_file", promptFilePath)
    .eq("export_name", exportName)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (data?.content) return { text: data.content as string, source: "db-active" };
  return { text: fallback, source: "compile-fallback" };
}

// Pad bytes come from the SINGLE SOURCE in src/lib/haiku-client/cache-pad.ts (buildCachePad);
// this script only sizes/validates N and prints the resulting totals.
const buildPad = buildCachePad;

(async () => {
  const targetIdx = process.argv.indexOf("--target");
  const TARGET = targetIdx > -1 ? Number(process.argv[targetIdx + 1]) : 4300;

  const eocDir = "src/lib/eoc/haiku-prompts";
  const pdDir = "src/lib/plan_doc/haiku-prompts";

  // --- EOC variants (pure-static consts + the MN builder; vocab="" worst case) ---
  const variants: Array<{ name: string; text: string; padCandidate: boolean }> = [
    { name: "eoc/prior_auth_codes", text: extractConst(`${eocDir}/prior-auth-codes.ts`, "INSTRUCTIONS"), padCandidate: true },
    { name: "eoc/appeals_procedures", text: extractConst(`${eocDir}/appeals-procedures.ts`, "INSTRUCTIONS"), padCandidate: true },
    { name: "eoc/cob_rules", text: extractConst(`${eocDir}/cob-rules.ts`, "INSTRUCTIONS"), padCandidate: true },
    { name: "eoc/eligibility_rules", text: extractConst(`${eocDir}/eligibility-rules.ts`, "INSTRUCTIONS"), padCandidate: true },
    { name: "eoc/definitions", text: extractConst(`${eocDir}/definitions.ts`, "INSTRUCTIONS"), padCandidate: true },
    { name: "eoc/aca_compliance", text: extractConst(`${eocDir}/aca-compliance.ts`, "INSTRUCTIONS"), padCandidate: true },
    { name: "eoc/mn OFF (no vocab)", text: buildMedicalNecessityPrompt("", false), padCandidate: true },
    { name: "eoc/mn ON  (no vocab)", text: buildMedicalNecessityPrompt("", true), padCandidate: true },
  ];

  // --- plan-doc variants (BASE + S93 active supplements; layouts as dispatched) ---
  const piBase = extractConst(`${pdDir}/plan-identity.ts`, "BASE_INSTRUCTIONS");
  const piFed = await activeSupplement(`${pdDir}/plan-identity.ts`, "FEDERAL_SBC_TABULAR_SUPPLEMENT", extractConst(`${pdDir}/plan-identity.ts`, "FEDERAL_SBC_TABULAR_SUPPLEMENT"));
  const scBase = extractConst(`${pdDir}/services-cost-sharing.ts`, "BASE_INSTRUCTIONS");
  const scFed = await activeSupplement(`${pdDir}/services-cost-sharing.ts`, "FEDERAL_SBC_TABULAR_SUPPLEMENT", extractConst(`${pdDir}/services-cost-sharing.ts`, "FEDERAL_SBC_TABULAR_SUPPLEMENT"));
  const scEoc = await activeSupplement(`${pdDir}/services-cost-sharing.ts`, "FULL_EOC_NARRATIVE_SUPPLEMENT", extractConst(`${pdDir}/services-cost-sharing.ts`, "FULL_EOC_NARRATIVE_SUPPLEMENT"));
  const scThes = extractConst(`${pdDir}/services-cost-sharing.ts`, "THESAURUS_PHASE1A_SUPPLEMENT");
  variants.push(
    { name: `pd/plan_identity BASE`, text: piBase, padCandidate: true },
    { name: `pd/plan_identity +fed_sbc (${piFed.source})`, text: piBase + piFed.text, padCandidate: true },
    { name: `pd/services BASE`, text: scBase, padCandidate: true },
    { name: `pd/services +fed_sbc (${scFed.source})`, text: scBase + scFed.text, padCandidate: true },
    { name: `pd/services +full_eoc (${scEoc.source})`, text: scBase + scEoc.text, padCandidate: true },
    { name: `pd/services +full_eoc +thesaurus`, text: scBase + scEoc.text + scThes, padCandidate: true },
    { name: `pd/access_instructions`, text: extractConst(`${pdDir}/access-instructions.ts`, "INSTRUCTIONS"), padCandidate: true },
  );

  console.log(`\nReal-token measurement (${MODEL}; count_tokens incl. ~7-tok message scaffolding; TARGET=${TARGET}):\n`);
  const measured: Array<{ name: string; chars: number; tokens: number; padCandidate: boolean }> = [];
  for (const v of variants) {
    const tokens = await realTokens(v.text);
    measured.push({ name: v.name, chars: v.text.length, tokens, padCandidate: v.padCandidate });
    console.log(`  ${v.name.padEnd(42)} ${String(v.text.length).padStart(7)} chars  ${String(tokens).padStart(6)} tok  ${tokens >= TARGET ? "ALREADY >= TARGET (pad not needed)" : `short by ${TARGET - tokens}`}`);
  }

  const needPad = measured.filter((m) => m.padCandidate && m.tokens < TARGET);
  const binding = needPad.reduce((a, b) => (a.tokens < b.tokens ? a : b));
  console.log(`\nBinding (smallest) pad-needing variant: ${binding.name} @ ${binding.tokens} tok -> pad must add >= ${TARGET - binding.tokens} tok`);

  // Size the pad: iterate N until binding + pad >= TARGET (pad measured standalone; concatenation
  // token count is within a token or two of the sum for ASCII text — verified by the final check).
  let n = Math.ceil((TARGET - binding.tokens) / 14); // ~14-15 real tok per numbered line
  let padTokens = 0;
  for (let iter = 0; iter < 6; iter++) {
    padTokens = await realTokens(buildPad(n));
    const combined = await realTokens(buildPad(n) + variants.find((v) => v.name === binding.name)!.text);
    console.log(`  N=${n}: pad=${padTokens} tok, pad+binding=${combined} tok`);
    if (combined >= TARGET + 25) break; // 25-tok slack over target (target already carries margin over 4096)
    n += Math.ceil((TARGET + 25 - combined) / 14) + 2;
  }

  console.log(`\nFINAL: N=${n} lines, pad ~= ${padTokens} real tokens, ${buildPad(n).length} chars.`);
  console.log(`Per-variant padded totals:`);
  for (const m of measured) {
    if (!m.padCandidate) continue;
    console.log(`  ${m.name.padEnd(42)} ${m.tokens < TARGET ? `padded -> ~${m.tokens + padTokens} tok` : `unpadded ${m.tokens} tok (already >= ${TARGET})`}`);
  }

  const outFile = "/tmp/cache-pad-v1.txt";
  fs.writeFileSync(outFile, buildPad(n));
  console.log(`\nPad body written to ${outFile} (embed into src/lib/haiku-client/cache-pad.ts).`);
})();
