/**
 * Unmapped bill line items — admin classify support (plans/unmapped_line_items_admin_fix.md).
 *
 * Pure grouping helpers for claim_line_items rows with service_slug = null.
 * The admin surface groups identical lines (same code + code type + description,
 * or same description when code-less) so one assignment covers every occurrence.
 * Pure functions — no DB, no HTTP — fixture-tested via scripts/admin-unmapped-fixture.ts.
 */

import type { ProcedureCodeType } from "@/lib/billing/types";

/** Defensive cap on rows fetched for grouping — well above any realistic backlog. */
export const UNMAPPED_FETCH_CAP = 1000;
/** Defensive cap on groups returned to the UI. */
export const UNMAPPED_GROUP_CAP = 200;

export const PROCEDURE_CODE_TYPES: readonly ProcedureCodeType[] = [
  "CPT",
  "HCPCS_L2",
  "REV",
  "DRG",
  "NDC",
  "G_CODE",
  "CAT_II",
] as const;

export interface UnmappedLineItemRow {
  id: string;
  billing_code: string | null;
  billing_code_type: string | null;
  description: string | null;
}

export interface UnmappedGroup {
  /** Stable grouping key (code|type|description, or desc:description when code-less). */
  key: string;
  billingCode: string | null;
  billingCodeType: string | null;
  description: string;
  count: number;
  lineItemIds: string[];
}

/**
 * Build the grouping key for one row. Coded rows group on (code, type, description)
 * — the same triple the flywheel's identity is keyed on, so one admin assignment
 * maps 1:1 onto one billing_code_identity row. Code-less rows group on the
 * normalized description alone (the flywheel is code-keyed and can't hold them).
 */
export function unmappedGroupKey(row: UnmappedLineItemRow): string {
  const desc = (row.description ?? "").trim();
  if (row.billing_code && row.billing_code_type) {
    return `${row.billing_code}|${row.billing_code_type}|${desc.toLowerCase()}`;
  }
  return `desc:${desc.toLowerCase()}`;
}

/**
 * Group null-slug rows for the admin UI. Rows without a usable description are
 * dropped (nothing for a human to classify against — they surface via the raw
 * count instead). Groups sort by count desc, then description.
 */
export function groupUnmappedLineItems(rows: UnmappedLineItemRow[]): UnmappedGroup[] {
  const groups = new Map<string, UnmappedGroup>();
  for (const row of rows) {
    const desc = (row.description ?? "").trim();
    if (!desc) continue;
    const key = unmappedGroupKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.lineItemIds.push(row.id);
    } else {
      groups.set(key, {
        key,
        billingCode: row.billing_code && row.billing_code_type ? row.billing_code : null,
        billingCodeType: row.billing_code && row.billing_code_type ? row.billing_code_type : null,
        description: desc,
        count: 1,
        lineItemIds: [row.id],
      });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count || a.description.localeCompare(b.description))
    .slice(0, UNMAPPED_GROUP_CAP);
}

/** True when the string is a code type the flywheel identity table accepts. */
export function isProcedureCodeType(value: string | null | undefined): value is ProcedureCodeType {
  return !!value && (PROCEDURE_CODE_TYPES as readonly string[]).includes(value);
}

// The line↔identity vocabulary bridge lives in the canonical vocabulary module
// (code-type-inference.ts) — re-exported here for the admin surface's callers.
export { toIdentityCodeType, isAssignableCodeType } from "@/lib/billing/code-type-inference";
