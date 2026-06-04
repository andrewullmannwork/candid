/**
 * Ing-E Phase 1 — schema-driven surface inventory (provable completeness).
 *
 * Scans supabase/migrations/*.sql for TEXT/JSONB/VARCHAR/CITEXT columns, then
 * cross-references CANONICAL_SURFACES. Any text/jsonb column on a canonical /
 * cross-user table (CROSS_USER_TABLE_PATTERNS) NOT already classified is reported
 * as UNCLASSIFIED — split into "likely free-text" (review closely) vs "likely
 * structured" — so a missed excerpt surface (now, or a future one like
 * service_synonyms mig 145) cannot slip silently.
 *
 * Migration-DDL-derived (the additive schema source of truth). A live
 * information_schema cross-check needs a one-time exposed RPC — future hardening.
 *
 * Run from the worktree root: npx tsx scripts/calibration/pii/surface-inventory.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  CANONICAL_SURFACES,
  CROSS_USER_TABLE_PATTERNS,
  KNOWN_STRUCTURED_EXCLUSIONS,
} from "./surfaces";

const TYPE_RE = /(TEXT|JSONB|CITEXT|CHARACTER VARYING|VARCHAR|CHAR)\b/i;
const FREE_TEXT_HINT = /(excerpt|description|raw|notes?|source|snippet|comment|metadata|sources|suggestion|quote|verbatim|body|message|reason|text)/i;
const STRUCTURED_HINT = /(slug|status|name|type|level|^id$|_id$|key|tier|code|state|kind|category|label|signature)/i;

interface Col {
  table: string;
  column: string;
  type: string;
  migration: string;
}

function scanMigrations(dir: string): Col[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const cols: Col[] = [];
  const seen = new Set<string>();
  const record = (table: string, column: string, type: string, migration: string) => {
    const key = `${table}.${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    cols.push({ table, column, type: type.toUpperCase(), migration });
  };

  for (const file of files) {
    const text = readFileSync(resolve(dir, file), "utf8");
    const lines = text.split("\n");
    let currentTable: string | null = null;
    let inCreate = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("--")) continue;

      const create = /^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?"?(\w+)"?/i.exec(line);
      if (create) {
        currentTable = create[1];
        inCreate = true;
        continue;
      }
      const alter = /^ALTER TABLE(?:\s+ONLY)?\s+(?:public\.)?"?(\w+)"?/i.exec(line);
      if (alter) {
        currentTable = alter[1];
        inCreate = false;
        // ADD COLUMN may sit on the same line
        const add = /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"?(\w+)"?\s+([A-Za-z][\w ]*)/i.exec(line);
        if (add && TYPE_RE.test(add[2])) record(currentTable, add[1], TYPE_RE.exec(add[2])![1], file);
        continue;
      }
      if (inCreate && /^\)/.test(line)) {
        inCreate = false;
        continue;
      }
      // ADD COLUMN on its own line (multi-column ALTER)
      const add = /^ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"?(\w+)"?\s+([A-Za-z][\w ]*)/i.exec(line);
      if (add && currentTable && TYPE_RE.test(add[2])) {
        record(currentTable, add[1], TYPE_RE.exec(add[2])![1], file);
        continue;
      }
      // column line inside a CREATE TABLE block
      if (inCreate && currentTable) {
        const col = /^"?(\w+)"?\s+([A-Za-z][\w ]*)/.exec(line);
        if (col && TYPE_RE.test(col[2]) && col[1].toUpperCase() !== "CONSTRAINT") {
          record(currentTable, col[1], TYPE_RE.exec(col[2])![1], file);
        }
      }
    }
  }
  return cols;
}

const isCrossUser = (table: string): boolean =>
  CROSS_USER_TABLE_PATTERNS.some((re) => re.test(table));
const isClassified = (table: string, column: string): boolean =>
  CANONICAL_SURFACES.some((s) => s.table === table && (s.column === column || s.column === "*")) ||
  KNOWN_STRUCTURED_EXCLUSIONS.includes(`${table}.${column}`);

function main(): void {
  const dir = resolve(process.cwd(), "supabase/migrations");
  const cols = scanMigrations(dir);

  const crossUserCols = cols.filter((c) => isCrossUser(c.table));
  const unclassified = crossUserCols.filter((c) => !isClassified(c.table, c.column));
  const unclassifiedFreeText = unclassified.filter(
    (c) => c.type === "JSONB" || (FREE_TEXT_HINT.test(c.column) && !STRUCTURED_HINT.test(c.column)),
  );
  const unclassifiedStructured = unclassified.filter((c) => !unclassifiedFreeText.includes(c));

  console.log("════════════════════════════════════════════════════════════════");
  console.log(" Ing-E surface inventory (migration-DDL-derived)");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(`Scanned ${cols.length} TEXT/JSONB columns across migrations.`);
  console.log(`Cross-user-universe columns: ${crossUserCols.length}`);
  console.log(`Classified canonical surfaces: ${CANONICAL_SURFACES.length} (${CANONICAL_SURFACES.filter((s) => s.sweep).length} swept)`);
  console.log("");
  console.log("── CLASSIFIED surfaces ──");
  for (const s of CANONICAL_SURFACES) {
    console.log(`  [T${s.tier}${s.sweep ? " sweep" : " FLAG "}] ${s.id}  (${s.visibility})`);
  }
  console.log("");
  console.log(`── UNCLASSIFIED · LIKELY FREE-TEXT (review closely): ${unclassifiedFreeText.length} ──`);
  for (const c of unclassifiedFreeText) {
    console.log(`  ⚠️  ${c.table}.${c.column}  [${c.type}]  (${c.migration})`);
  }
  console.log("");
  console.log(`── UNCLASSIFIED · likely structured (probably not excerpt-bearing): ${unclassifiedStructured.length} ──`);
  for (const c of unclassifiedStructured) {
    console.log(`     ${c.table}.${c.column} [${c.type}]`);
  }

  const out = {
    generated_for: "Ing-E Phase 1 surface inventory (S165)",
    method: "migration-DDL-derived; live information_schema cross-check is future hardening",
    totals: {
      text_jsonb_columns: cols.length,
      cross_user_universe: crossUserCols.length,
      classified_surfaces: CANONICAL_SURFACES.length,
      swept: CANONICAL_SURFACES.filter((s) => s.sweep).length,
      unclassified_free_text: unclassifiedFreeText.length,
      unclassified_structured: unclassifiedStructured.length,
    },
    classified: CANONICAL_SURFACES,
    unclassified_free_text: unclassifiedFreeText,
    unclassified_structured: unclassifiedStructured,
  };
  const outPath = resolve(process.cwd(), "scripts/calibration/pii/surface-inventory.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  if (unclassifiedFreeText.length > 0) {
    console.log(`\n⚠️  ${unclassifiedFreeText.length} likely-free-text canonical column(s) NOT yet classified — review before declaring the audit complete.`);
  }
}

main();
