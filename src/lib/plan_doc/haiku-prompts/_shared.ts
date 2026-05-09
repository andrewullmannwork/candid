/**
 * Plan_doc haiku-prompts shared module — re-export shim to `@/lib/haiku-client/base`.
 *
 * Mirrors src/lib/eoc/haiku-prompts/_shared.ts pattern. The actual Haiku-call
 * infrastructure lives in src/lib/haiku-client/base.ts (extracted at Phase 3.2 Task A
 * per Pattern P-6); this shim preserves the import-from-sibling-file convention
 * used across all per-parser haiku-prompts directories.
 */

export {
  HAIKU_MODEL,
  HAIKU_MAX_OUTPUT,
  estimateTokens,
  adaptiveMaxTokens,
  getClient,
  parseHaikuJSON,
  callHaikuWithCache,
  type HaikuCallResult,
} from "@/lib/haiku-client/base";
