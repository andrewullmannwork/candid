/**
 * Bill-list display dedupe — collapse duplicate uploads of the same bill.
 *
 * S74 hotfix #3+#4, extracted from /api/claims/route.ts at S307 so a fixture
 * can pin it: until ingestion-layer dedup ships, a user re-uploading the same
 * PDF creates multiple `claims` rows AND multiple `documents` rows with
 * DIFFERENT source_document_ids but identical provider + date + total. The
 * composite key is primary; doc_id is the fallback when the composite can't be
 * computed.
 *
 * Composite key: `(date_of_service, total_billed_cents, normalized_provider)`.
 * Edge case: two genuinely different bills with identical (date, total,
 * provider) from the same user collapse incorrectly — accepted tradeoff
 * (real-world rare, vs. visible duplicates on every test re-upload).
 *
 * S307 (tracker AM) — representative selection is CASE-AWARE. "Newest wins"
 * silently displaced a claim carrying a live case: re-uploading a bill the
 * user was already fighting made its letters, case history and guided rail
 * vanish from the list (the S304 Ballard incident, restored only by
 * soft-deleting the duplicate). Among rows sharing a fingerprint, a copy
 * carrying the user's WORK now wins over recency:
 *
 *   work = a non-cancelled dispute letter (`caseWorkClaimIds`; resolved counts
 *          — a finished case is still history worth showing), OR any
 *          guided-step progress in the row's own metadata (checked or skipped
 *          — phone work predates the first letter).
 *
 * Ties — both worked, or neither — keep today's newest-wins.
 *
 * Why this rule is permanent rather than a stopgap patch: the planned
 * ingestion-layer file-hash dedup only collapses byte-identical files. The
 * same bill re-uploaded as a PHOTO of the paper (vs the original PDF) will
 * always slip past a file hash and land here, so this display-layer selection
 * stays load-bearing and must never hide a live case.
 *
 * Caller contract: `rawClaims` pre-sorted DESC by created_at (the first row of
 * a fingerprint group is the newest). Output preserves input order; a winning
 * older row appears at its own created_at position.
 */

export interface DedupableBillRow {
  id: string;
  source_document_id: string | null;
  date_of_service: string | null;
  total_billed: number | null;
  metadata: Record<string, unknown> | null;
}

function billFingerprint(c: DedupableBillRow): string {
  const provider =
    (c.metadata as { provider?: { name?: string } } | null)?.provider?.name?.trim().toLowerCase() ||
    "";
  // Round total to whole cents so floating-point noise from re-parses
  // (e.g., $1,297.00 vs $1297.0000001) doesn't break the fingerprint.
  const totalCents = Math.round(Number(c.total_billed ?? 0) * 100);
  const date = c.date_of_service ?? "";

  // Composite fingerprint is primary; collapses re-uploads of the same bill
  // even when each upload creates a different documents row.
  const composable = !!(provider && date && totalCents > 0);
  return composable
    ? `fp:${date}|${totalCents}|${provider}`
    : c.source_document_id
      ? `doc:${c.source_document_id}`
      : `id:${c.id}`; // last resort: each row is unique (no dedup happens)
}

/** Any recorded case work on this row — a dispute letter (by id set) or guided-step progress (own metadata). */
export function hasCaseWork(
  c: DedupableBillRow,
  caseWorkClaimIds: ReadonlySet<string>,
): boolean {
  if (caseWorkClaimIds.has(c.id)) return true;
  const steps = (
    c.metadata as {
      guideSteps?: Record<string, { checkedAt?: string | null; skippedAt?: string | null } | null>;
    } | null
  )?.guideSteps;
  if (!steps || typeof steps !== "object") return false;
  return Object.values(steps).some((s) => !!(s && (s.checkedAt || s.skippedAt)));
}

export function dedupBillsByFingerprint<T extends DedupableBillRow>(
  rawClaims: T[],
  caseWorkClaimIds: ReadonlySet<string> = new Set(),
): T[] {
  const winners = new Map<string, T>();
  for (const c of rawClaims) {
    const fp = billFingerprint(c);
    const incumbent = winners.get(fp);
    if (!incumbent) {
      winners.set(fp, c);
      continue;
    }
    // Input is newest-first, so the incumbent is the newer row; an older row
    // takes the slot only by carrying work the incumbent lacks.
    if (!hasCaseWork(incumbent, caseWorkClaimIds) && hasCaseWork(c, caseWorkClaimIds)) {
      winners.set(fp, c);
    }
  }
  const keep = new Set<string>();
  for (const c of winners.values()) keep.add(c.id);
  return rawClaims.filter((c) => keep.has(c.id));
}
