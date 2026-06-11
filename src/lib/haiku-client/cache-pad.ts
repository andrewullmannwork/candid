/**
 * cache_pad_v1 — static prompt-cache eligibility pad (S187 Session A "H-EOC").
 *
 * WHY: the shared Haiku client already attaches `cache_control: {type:"ephemeral"}` to the
 * static instruction block of every call (base.ts), but Haiku 4.5's minimum cacheable prefix
 * is 4096 REAL tokens and every EOC/plan-doc prompt variant measured 635-3,750 tokens
 * (S187 `scripts/calibration/thesaurus/pad-sizing.ts`) — so caching has been a silent no-op.
 * Prepending this semantically-inert pad lifts every padded prompt to >=4,642 real tokens,
 * engaging caching: chunk 1 of a section writes the prefix (1.25x), chunks 2..N read it (0.1x).
 *
 * CONTRACT (do not break):
 * - ASCII-only, deterministic, SELF-DELIMITING (ends with "\n\n") — call sites do a bare
 *   `HAIKU_CACHE_PAD + INSTRUCTIONS` with no separator logic.
 * - Contains NO instructions, NO insurance/document content, none of the P2 marker strings,
 *   and not the token "EXTRACT" (the "## NOW EXTRACT..." trailer stays the unique navigation
 *   cue). The eoc-mn-prompt-gate fixture asserts these properties.
 * - EDITING THIS CONSTANT (even one byte) busts the production prompt cache for every padded
 *   parser AND the committed eoc-mn-prompt-gate goldens. Re-sizing is a deliberate code
 *   change: bump PAD_LINES -> run pad-sizing.ts (validates every variant >= target with real
 *   count_tokens) -> run regen-goldens.ts -> re-run the fixture suite. That committed regen
 *   path is the Ship Gate G6 evidence (G6 is N/A-with-reason here: a runtime-tunable pad
 *   would let DB state change prompt bytes, breaking golden pinning + cache identity).
 * - PARKED (deliberate, post-T5): replacing the inert filler with value-adding static
 *   reference content (the 0.1x read rate would then apply to tokens we want anyway). Not
 *   done now because changing prompt semantics before the T5 universal eval would stale it.
 *
 * Sized S187: PAD_LINES=262 -> ~4,013 real tokens (count_tokens, claude-haiku-4-5-20251001);
 * binding variant pd/access_instructions (635 tok) lands at 4,642.
 */

export const HAIKU_CACHE_PAD_VERSION = "cache_pad_v1";

const PAD_LINES = 262;

/** Deterministic pad body — single source of the pad bytes (pad-sizing.ts imports this). */
export function buildCachePad(lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, i) => `Padding line ${i + 1} of ${lines}. No operational content.`,
  ).join("\n");
  return (
    `## CACHE PADDING (NON-OPERATIVE) - ${HAIKU_CACHE_PAD_VERSION}\n` +
    `This block exists only to enable Anthropic prompt caching by lifting the static prompt\n` +
    `prefix above the minimum cacheable length. It contains no instructions and no document\n` +
    `content. The task instructions begin after the END CACHE PADDING marker.\n` +
    `${body}\n` +
    `## END CACHE PADDING\n\n`
  );
}

export const HAIKU_CACHE_PAD: string = buildCachePad(PAD_LINES);
