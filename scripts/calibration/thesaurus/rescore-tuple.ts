/**
 * A2b Phase 2 — FREE tuple re-score (no Haiku). Re-derives the LIVE deriveModifiers over the FROZEN
 * forward.json (resolved slugs untouched) + re-runs the tuple scorer against the (regenerated) gt.json.
 *
 * Deterministic: modifiers are description-derived, so this EXACTLY reproduces the tuple metrics an N-run
 * gate would score (the slug B1/B2 in score.ts are the only stochastic part, and they're unaffected here).
 *
 * Faithfulness gate: run this with the UN-edited deriveModifiers on the current snapshot FIRST — it must
 * reproduce the recorded tuple-scorecard.md. Only then is a post-edit delta attributable to the edit.
 *
 * Run: npx tsx scripts/calibration/thesaurus/rescore-tuple.ts <snapshot-dir>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { deriveModifiers } from "@/lib/claims/service-resolver";
import { buildTupleScoreCard, tupleScoreCardMd, type DecodeMap } from "./score-tuple";
import type { GtService, ForwardMapEntry } from "./types";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: rescore-tuple.ts <snapshot-dir>");
  process.exit(1);
}
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

const gt = readJson<GtService[]>(join(dir, "gt.json"));
const forwardRaw = readJson<ForwardMapEntry[]>(join(dir, "forward.json"));
const renameMap = existsSync(join(dir, "rename-map.json"))
  ? readJson<Record<string, string>>(join(dir, "rename-map.json"))
  : {};
const decodeMap = readJson<DecodeMap>(join(dirname(fileURLToPath(import.meta.url)), "decode-map.json"));

const byId = new Map(gt.map((g) => [g.id, g]));
// Re-derive modifiers from the LIVE deriveModifiers on each row's serviceName; slug stays frozen.
const forward: ForwardMapEntry[] = forwardRaw.map((f) => {
  const g = byId.get(f.gtId);
  if (!g) return f;
  const m = deriveModifiers(g.serviceName);
  return { ...f, placeOfService: m.placeOfService, component: m.component, multiLabel: m.multiLabel, isPreventiveEligible: m.isPreventiveEligible, planTierLabel: m.planTierLabel };
});

const card = buildTupleScoreCard({ gt, forward, decodeMap, renameMap });
const md = tupleScoreCardMd(card);
writeFileSync(join(dir, "tuple-scorecard.rescore.json"), JSON.stringify(card, null, 2));
writeFileSync(join(dir, "tuple-scorecard.rescore.md"), md);
console.log(md);
console.log(
  `\n[rescore] re-derived modifiers on ${forward.length} frozen forward rows; gt=${gt.length}; renameKeys=${Object.keys(renameMap).length}`,
);
