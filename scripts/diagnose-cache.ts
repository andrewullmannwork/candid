/**
 * One-shot diagnostic — investigates why prompt caching isn't engaging.
 *
 * Tests:
 *   1. Verify credits restored.
 *   2. Measure actual prompt sizes (chars + estimated tokens).
 *   3. Run same call twice (cache miss → cache hit) and inspect usage
 *      object for `cache_creation_input_tokens` + `cache_read_input_tokens`.
 *   4. Test with a deliberately long padded prompt to verify the min-threshold theory.
 */

import { config } from "dotenv";
import { resolve } from "path";
import Anthropic from "@anthropic-ai/sdk";

import { extractDefinitions as _ed } from "../src/lib/eoc/haiku-prompts/definitions";
void _ed; // ensure module loads (for module side effects); avoid unused-var lint

config({ path: resolve(__dirname, "../.env.local"), override: true });

// Re-import the prompt strings directly by reading their files.
import * as fs from "fs";

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

async function callTwice(systemPrompt: string, userContent: string, label: string): Promise<{ first: Usage; second: Usage }> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const client = new Anthropic({ apiKey, timeout: 60000 });

  const messages = [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } },
        { type: "text" as const, text: "\n\n" + userContent },
      ],
    },
  ];

  console.log(`\n=== ${label} ===`);
  console.log(`  system prompt chars: ${systemPrompt.length}`);
  console.log(`  estimated tokens: ${Math.ceil(systemPrompt.length / 4)}`);

  const r1 = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages,
  });
  const usage1 = r1.usage as unknown as Usage;
  console.log(`  call 1 usage:`, JSON.stringify(usage1));

  // Wait briefly to ensure cache is registered, then call again.
  await new Promise((r) => setTimeout(r, 2000));

  const r2 = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages,
  });
  const usage2 = r2.usage as unknown as Usage;
  console.log(`  call 2 usage:`, JSON.stringify(usage2));

  return { first: usage1, second: usage2 };
}

async function callTwiceSystemField(systemPrompt: string, userContent: string, label: string): Promise<{ first: Usage; second: Usage }> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const client = new Anthropic({ apiKey, timeout: 60000 });

  console.log(`\n=== ${label} (system field placement) ===`);
  console.log(`  system prompt chars: ${systemPrompt.length}`);

  const params = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    system: [{ type: "text" as const, text: systemPrompt, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: userContent }],
  };

  const r1 = await client.messages.create(params);
  const usage1 = r1.usage as unknown as Usage;
  console.log(`  call 1 usage:`, JSON.stringify(usage1));

  await new Promise((r) => setTimeout(r, 2000));

  const r2 = await client.messages.create(params);
  const usage2 = r2.usage as unknown as Usage;
  console.log(`  call 2 usage:`, JSON.stringify(usage2));

  return { first: usage1, second: usage2 };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("ANTHROPIC_API_KEY: NOT SET");
    process.exit(1);
  }

  // 1. Measure all 6 EOC haiku-prompt sizes.
  console.log("=== EOC haiku-prompt sizes ===");
  const promptFiles = [
    "src/lib/eoc/haiku-prompts/prior-auth-codes.ts",
    "src/lib/eoc/haiku-prompts/medical-necessity.ts",
    "src/lib/eoc/haiku-prompts/appeals-procedures.ts",
    "src/lib/eoc/haiku-prompts/cob-rules.ts",
    "src/lib/eoc/haiku-prompts/eligibility-rules.ts",
    "src/lib/eoc/haiku-prompts/definitions.ts",
  ];
  for (const f of promptFiles) {
    const src = fs.readFileSync(resolve(__dirname, "..", f), "utf-8");
    const m = src.match(/const INSTRUCTIONS = `([\s\S]*?)`;/);
    if (m) {
      const instructions = m[1];
      console.log(`  ${f.split("/").pop()}: ${instructions.length} chars (~${Math.ceil(instructions.length / 4)} tokens)`);
    }
  }

  // 2. Test current implementation (user content block w/ cache_control)
  const definitionsSrc = fs.readFileSync(resolve(__dirname, "../src/lib/eoc/haiku-prompts/definitions.ts"), "utf-8");
  const definitionsPrompt = definitionsSrc.match(/const INSTRUCTIONS = `([\s\S]*?)`;/)?.[1] ?? "";
  const sampleUserContent = "Definitions\n\nMedical Necessity — Health care services or supplies needed to diagnose or treat an illness.";

  await callTwice(definitionsPrompt, sampleUserContent, "Current impl: definitions prompt as user content block");

  // 3. Test system-field placement
  await callTwiceSystemField(definitionsPrompt, sampleUserContent, "Alt: definitions prompt in system field");

  // 4. Test with long padded prompt to confirm minimum threshold theory
  const padded = definitionsPrompt + "\n\n" + Array(40).fill("This is filler text to extend the prompt past the minimum cache threshold.").join(" ");
  await callTwice(padded, sampleUserContent, "Padded prompt (~2x size) as user content block");
  await callTwiceSystemField(padded, sampleUserContent, "Padded prompt in system field");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
