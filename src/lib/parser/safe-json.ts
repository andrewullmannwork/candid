/**
 * src/lib/parser/safe-json.ts — robust JSON extraction from Haiku responses.
 *
 * S94 B1 — closes the stochastic-dispatch + missing-provenance + classifier-crash
 * chain that bit B1 Stage 4 testing all afternoon. Haiku models occasionally
 * emit trailing reasoning AFTER the closing brace:
 *
 *   {"type":"sbc","confidence":0.85} **Reasoning:** This document is clearly...
 *
 * jsonrepair barfs on the trailing text (it can't repair "JSON object then prose").
 * The result was Haiku classifier returning `classifiedType="other"` every other
 * upload, which cascaded through the dispatch logic into different parsers per run.
 *
 * The fix: extract the OUTERMOST balanced {} block by walking the string with
 * brace-depth tracking (respecting string literals so escaped quotes don't break
 * the count), then pass that to jsonrepair. Universal across all Haiku parsers.
 *
 * Replaces the existing `text.replace(/```json/, "").trim() → JSON.parse → jsonrepair`
 * pattern in claude-extractor, haiku-bill-parser, extraction-dedup, service-mapper,
 * and haiku-classify.
 */

import { jsonrepair } from "jsonrepair";

/**
 * Strip markdown code fences from a Haiku response. Idempotent.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```json\s*\n?/g, "").replace(/```\s*\n?/g, "").trim();
}

/**
 * Find the substring representing the outermost JSON object (or array) in the
 * input. Walks the string tracking brace/bracket depth while respecting string
 * literals (so `"foo bar { baz }"` inside a string value doesn't trip depth).
 * Returns the [start, end+1) slice as a string, or null if no balanced block found.
 *
 * Handles both objects ({...}) and arrays ([...]) — claude-extractor sometimes
 * returns top-level arrays.
 */
function extractBalancedJsonBlock(text: string): string | null {
  let firstObjStart = -1;
  let firstArrStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" && firstObjStart === -1) firstObjStart = i;
    if (c === "[" && firstArrStart === -1) firstArrStart = i;
    if (firstObjStart !== -1 || firstArrStart !== -1) break;
  }
  const start =
    firstObjStart === -1
      ? firstArrStart
      : firstArrStart === -1
        ? firstObjStart
        : Math.min(firstObjStart, firstArrStart);
  if (start === -1) return null;

  const openCh = text[start];
  const closeCh = openCh === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let prevWasEscape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (prevWasEscape) {
        prevWasEscape = false;
        continue;
      }
      if (c === "\\") {
        prevWasEscape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parse a Haiku response as JSON, tolerating:
 *   - Markdown code fences (```json ... ```)
 *   - Trailing reasoning text after the closing brace
 *   - Light malformations within the JSON itself (handled by jsonrepair)
 *
 * Returns the parsed value (T defaults to unknown). Throws if no balanced JSON
 * block can be found OR if the extracted block can't be repaired into valid JSON.
 *
 * Callers should wrap in try/catch if they want to fall back to a sentinel.
 */
export function parseHaikuJSON<T = unknown>(text: string): T {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("parseHaikuJSON: empty or non-string input");
  }
  const cleaned = stripCodeFences(text);

  // Fast path: byte-exact JSON.parse on the cleaned text. Avoids the brace-walk
  // overhead when Haiku emits clean JSON (the common case).
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // fall through
  }

  // Slow path: extract balanced block, then jsonrepair.
  const block = extractBalancedJsonBlock(cleaned);
  if (!block) {
    throw new Error(
      `parseHaikuJSON: no balanced JSON block found in input (length ${cleaned.length})`,
    );
  }

  try {
    return JSON.parse(block) as T;
  } catch {
    const repaired = jsonrepair(block);
    return JSON.parse(repaired) as T;
  }
}
