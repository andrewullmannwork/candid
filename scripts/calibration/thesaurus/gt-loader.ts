/** GT loader + validator (pure). Reads the frozen mapping-GT JSON. */
import { readFileSync } from "fs";
import type { GtService, DocType } from "./types";

const DOC_TYPES: DocType[] = ["sbc", "eoc", "plan_document"];

export function loadGt(path: string, validSlugs?: Set<string>): { gt: GtService[]; warnings: string[] } {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const arr: unknown[] = Array.isArray(raw) ? raw : raw.services ?? [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const gt: GtService[] = [];
  arr.forEach((r, i) => {
    const g = r as Partial<GtService>;
    if (!g.id) { warnings.push(`entry ${i}: missing id — skipped`); return; }
    if (seen.has(g.id)) { warnings.push(`duplicate id ${g.id} — skipped`); return; }
    if (!g.docId || !g.serviceName) { warnings.push(`${g.id}: missing docId/serviceName — skipped`); return; }
    if (!DOC_TYPES.includes(g.docType as DocType)) { warnings.push(`${g.id}: bad docType ${g.docType}`); }
    if (g.adjudicationStatus !== "auto" && g.adjudicationStatus !== "andrew") { warnings.push(`${g.id}: bad adjudicationStatus ${g.adjudicationStatus}`); }
    if (validSlugs && g.correctSlug && !validSlugs.has(g.correctSlug)) warnings.push(`${g.id}: correctSlug "${g.correctSlug}" not in catalog`);
    seen.add(g.id);
    gt.push(g as GtService);
  });
  return { gt, warnings };
}
