/**
 * EOC haiku-prompts shared module — re-export shim to `@/lib/haiku-client/base`.
 *
 * The actual Haiku-call infrastructure was extracted to `src/lib/haiku-client/base.ts`
 * at Phase 3.2 Task A (Session 53) per Pattern P-6 hard rule, so EOC + new SBC parser
 * + future formulary parser all share one source of truth. This shim preserves
 * existing EOC import paths (`from "./_shared"` / `from "./haiku-prompts/_shared"`)
 * to minimize churn during the refactor.
 *
 * EOC haiku-prompts files currently still import via `./_shared`. New parsers should
 * import directly from `@/lib/haiku-client/base`. This shim may be removed once EOC
 * imports migrate to the canonical path (low-priority follow-up; no functional gain).
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
