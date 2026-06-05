/**
 * Ing-E — shared canonical-surface iteration (single source for both pii-audit.ts
 * and pii-backfill.ts). Factored out of pii-audit.ts so the audit's "where is the
 * free text" and the backfill's "rewrite that free text in place" can never drift.
 *
 *   extractUnits()       — READ side: locate every redactable free-text unit in a row's column.
 *   redactColumnValue()  — WRITE side: rebuild a column value with a per-unit transform applied.
 *
 * Pure + deterministic. redactColumnValue injects its transform (RedactFn) so this
 * module has no dependency on the redactor itself.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CanonicalSurface } from "./pii-surfaces";

export const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Exhaustive keyset pagination by `id` (ascending). Offset pagination via .range() with
 * no ORDER BY returns an undefined, run-to-run-unstable row order that can DROP or
 * DOUBLE-COUNT rows across page boundaries — fatal for an exhaustive PII sweep/backfill
 * (a dropped row is missed PII). Keyset visits every row exactly once, reproducibly, and
 * is concurrent-insert-safe. `columns` MUST include `id` (the cursor key).
 */
export async function fetchAllKeyset(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  pageSize = 1000,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | number | null = null;
  for (;;) {
    let q = supabase.from(table).select(columns).order("id", { ascending: true }).limit(pageSize);
    if (cursor !== null) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as Record<string, unknown>[]));
    if (data.length < pageSize) break;
    const lastId = rows[rows.length - 1].id; // read from the cast rows (avoids GenericStringError cast)
    if (lastId == null) break; // row lacks id → cannot keyset; caller must use offset fallback
    cursor = lastId as string | number;
  }
  return rows;
}

/**
 * Offset-paginated fetch — fallback ONLY for the rare swept table without an `id` PK
 * (keyset needs id). Non-deterministic page partition; acceptable only where keyset can't
 * apply. id-bearing tables must use fetchAllKeyset.
 */
export async function fetchAllOffset(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  pageSize = 1000,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as Record<string, unknown>[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

/**
 * Single source for "read all of a surface's rows": exhaustive keyset by `id`, with a
 * transparent offset fallback for a table that has no `id` PK. Used by both the
 * calibration audit and the cron sweep so they fetch identically.
 */
export async function fetchSurfaceRows(
  supabase: SupabaseClient,
  table: string,
  column: string,
): Promise<{ rows: Record<string, unknown>[]; hasId: boolean }> {
  try {
    return { rows: await fetchAllKeyset(supabase, table, `id, ${column}`), hasId: true };
  } catch (e) {
    if (/does not exist/.test((e as Error).message)) {
      return { rows: await fetchAllOffset(supabase, table, column), hasId: false };
    }
    throw e;
  }
}

export interface Unit {
  rowId: string;
  field?: string;
  text: string;
  docRef?: string | null;
}

/** READ side — every redactable text unit in `row`'s surface column. */
export function extractUnits(surface: CanonicalSurface, row: Record<string, unknown>, rowId: string): Unit[] {
  const col = row[surface.column];
  const units: Unit[] = [];
  if (col == null) return units;
  switch (surface.kind) {
    case "text_column": {
      const t = asString(col);
      if (t && t.length) units.push({ rowId, text: t });
      break;
    }
    case "text_array": {
      for (const el of asArray(col)) {
        const t = asString(el);
        if (t && t.length) units.push({ rowId, text: t });
      }
      break;
    }
    case "jsonb_blob": {
      const t = typeof col === "string" ? col : JSON.stringify(col);
      if (t && t.length > 2) units.push({ rowId, text: t });
      break;
    }
    case "jsonb_array_field": {
      for (const el of asArray(col)) {
        const o = asObj(el);
        const t = o ? asString(o[surface.arrayField ?? ""]) : null;
        if (t && t.length) units.push({ rowId, text: t });
      }
      break;
    }
    case "jsonb_provenance_sources_excerpt": {
      const fp = asObj(col);
      if (fp) {
        for (const [field, entry] of Object.entries(fp)) {
          const e = asObj(entry);
          if (!e) continue;
          for (const s of asArray(e.sources)) {
            const so = asObj(s);
            const t = so ? asString(so.excerpt) : null;
            if (t && t.length) units.push({ rowId, field, text: t, docRef: so ? asString(so.document_ref) : null });
          }
        }
      }
      break;
    }
  }
  return units;
}

// ───────────────────────────── WRITE side ─────────────────────────────

export interface UnitRedaction {
  field?: string;
  before: string;
  after: string;
  patterns: string[];
}
export interface ColumnRedaction {
  /** Rebuilt column value — strictly === the input when nothing changed. */
  newValue: unknown;
  changed: boolean;
  /** Only the units that actually changed (for snapshot patterns + coverage asserts). */
  units: UnitRedaction[];
}
/** Injected transform — wraps redactText so this module stays redactor-agnostic. */
export type RedactFn = (text: string) => { redacted: string; changed: boolean; patterns: string[] };

/**
 * WRITE side — return the column value with `redact` applied to every text unit,
 * preserving structure/cardinality/order. `newValue` is the SAME reference as `col`
 * when nothing changed (so a no-op backfill writes nothing).
 */
export function redactColumnValue(surface: CanonicalSurface, col: unknown, redact: RedactFn): ColumnRedaction {
  const units: UnitRedaction[] = [];
  if (col == null) return { newValue: col, changed: false, units };
  switch (surface.kind) {
    case "text_column": {
      const t = asString(col);
      if (!t || !t.length) return { newValue: col, changed: false, units };
      const r = redact(t);
      if (r.changed) units.push({ before: t, after: r.redacted, patterns: r.patterns });
      return { newValue: r.changed ? r.redacted : col, changed: r.changed, units };
    }
    case "text_array": {
      let changed = false;
      const out = asArray(col).map((el) => {
        const t = asString(el);
        if (!t || !t.length) return el;
        const r = redact(t);
        if (!r.changed) return el;
        changed = true;
        units.push({ before: t, after: r.redacted, patterns: r.patterns });
        return r.redacted;
      });
      return { newValue: changed ? out : col, changed, units };
    }
    case "jsonb_array_field": {
      const key = surface.arrayField ?? "";
      let changed = false;
      const out = asArray(col).map((el) => {
        const o = asObj(el);
        const t = o ? asString(o[key]) : null;
        if (!o || !t || !t.length) return el;
        const r = redact(t);
        if (!r.changed) return el;
        changed = true;
        units.push({ before: t, after: r.redacted, patterns: r.patterns });
        return { ...o, [key]: r.redacted };
      });
      return { newValue: changed ? out : col, changed, units };
    }
    case "jsonb_provenance_sources_excerpt": {
      const fp = asObj(col);
      if (!fp) return { newValue: col, changed: false, units };
      let changed = false;
      const outFp: Record<string, unknown> = {};
      for (const [field, entry] of Object.entries(fp)) {
        const e = asObj(entry);
        if (!e || !Array.isArray(e.sources)) {
          outFp[field] = entry;
          continue;
        }
        const newSources = asArray(e.sources).map((s) => {
          const so = asObj(s);
          const t = so ? asString(so.excerpt) : null;
          if (!so || !t || !t.length) return s;
          const r = redact(t);
          if (!r.changed) return s;
          changed = true;
          units.push({ field, before: t, after: r.redacted, patterns: r.patterns });
          return { ...so, excerpt: r.redacted };
        });
        outFp[field] = { ...e, sources: newSources };
      }
      return { newValue: changed ? outFp : col, changed, units };
    }
    case "jsonb_blob": {
      // No wired jsonb_blob surface; redaction-in-place of arbitrary blobs is out of
      // scope (the redactor never wires one). Treated as a no-op.
      return { newValue: col, changed: false, units };
    }
    default:
      return { newValue: col, changed: false, units };
  }
}
