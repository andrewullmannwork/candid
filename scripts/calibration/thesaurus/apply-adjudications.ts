/**
 * Merge Andrew's adjudication worksheet back into gt.json (deterministic; no DB, no Haiku).
 *
 * Worksheet (from build-worksheet.ts) has an `ids` column (semicolon-separated — ONE id for a
 * random row, MANY for a tricky cluster) and a RULING column Andrew fills:
 *   OK            → confirm the proposed slug          (→ adjudicationStatus "andrew")
 *   <a slug>      → correct to this catalog slug        (→ andrew, correctSlug=<slug>)
 *   NO_CONCEPT    → genuinely untracked                 (→ andrew, correctSlug=null)
 *   DROP          → bad GT entry (extraction error)     (→ notFound=true, excluded)
 *   (blank)       → leave as auto (unadjudicated)
 * A cluster ruling applies to EVERY id in its `ids` cell.
 *
 * Run: npx tsx scripts/calibration/thesaurus/apply-adjudications.ts <gt.json> <worksheet.tsv> [catalog.json]
 */
import { readFileSync, writeFileSync } from "fs";
import type { GtService } from "./types";

type Stats = { ok: number; corrected: number; noConcept: number; dropped: number; blank: number; invalidSlug: number; unknownId: number };

// Andrew's natural vocabulary → canonical rulings (case-insensitive). "correct"=confirm, "new"=untracked.
const OK_WORDS = new Set(["OK", "CORRECT", "YES", "Y", "GOOD", "RIGHT", "CONFIRM", "✓"]);
const NC_WORDS = new Set(["NO_CONCEPT", "NO CONCEPT", "NO-CONCEPT", "NEW", "NEW_CONCEPT", "NEW CONCEPT", "NC", "NONE"]);
const DROP_WORDS = new Set(["DROP", "X", "JUNK", "BAD", "DELETE", "REMOVE"]);

function applyRuling(g: GtService, ruling: string, validSlugs: Set<string> | null, stats: Stats): void {
  const r = ruling.trim().toUpperCase();
  if (OK_WORDS.has(r)) { g.adjudicationStatus = "andrew"; stats.ok++; return; }
  if (NC_WORDS.has(r)) { g.adjudicationStatus = "andrew"; g.correctSlug = null; stats.noConcept++; return; }
  if (DROP_WORDS.has(r)) { g.notFound = true; g.adjudicationStatus = "andrew"; stats.dropped++; return; }
  // Otherwise treat as a slug correction — case-insensitive, validated against the catalog.
  const slug = ruling.trim().toLowerCase();
  if (validSlugs && !validSlugs.has(slug)) { stats.invalidSlug++; console.warn(`${g.id}: ruling "${ruling}" is not OK/NEW/DROP and not a catalog slug — skipped`); return; }
  g.adjudicationStatus = "andrew"; g.correctSlug = slug; stats.corrected++;
}

function main() {
  const [gtPath, tsvPath, catalogPath] = process.argv.slice(2);
  if (!gtPath || !tsvPath) throw new Error("usage: apply-adjudications.ts <gt.json> <worksheet.tsv> [catalog.json]");
  const gt: GtService[] = JSON.parse(readFileSync(gtPath, "utf8"));
  const byId = new Map(gt.map((g) => [g.id, g]));
  const validSlugs: Set<string> | null = catalogPath
    ? new Set((JSON.parse(readFileSync(catalogPath, "utf8")) as { slug: string }[]).map((c) => c.slug))
    : null;

  const rows = readFileSync(tsvPath, "utf8").split(/\r?\n/).filter(Boolean);
  const header = rows[0].split("\t").map((h) => h.trim().toLowerCase());
  const idsCol = header.indexOf("ids") >= 0 ? header.indexOf("ids") : header.indexOf("id");
  const ruleCol = header.indexOf("ruling");
  if (idsCol < 0 || ruleCol < 0) throw new Error("worksheet must have an 'ids' (or 'id') column and a 'RULING' column");

  const stats: Stats = { ok: 0, corrected: 0, noConcept: 0, dropped: 0, blank: 0, invalidSlug: 0, unknownId: 0 };
  for (const line of rows.slice(1)) {
    const cells = line.split("\t");
    const ruling = (cells[ruleCol] ?? "").trim();
    const ids = (cells[idsCol] ?? "").split(";").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) continue;
    if (!ruling) { stats.blank += ids.length; continue; }
    for (const id of ids) {
      const g = byId.get(id);
      if (!g) { stats.unknownId++; console.warn(`unknown id: ${id}`); continue; }
      applyRuling(g, ruling, validSlugs, stats);
    }
  }

  writeFileSync(gtPath, JSON.stringify(gt, null, 2));
  const andrew = gt.filter((g) => g.adjudicationStatus === "andrew").length;
  console.log(`adjudications applied to ${gtPath}:`, stats);
  console.log(`gt.json now has ${andrew}/${gt.length} andrew-adjudicated entries.`);
}
main();
