/**
 * sent-versions — the §0.9 rule-4 letter version stack (S299 phase 2a).
 *
 * A letter step can hold multiple artifacts: immutable sent versions + at most
 * one live draft. Storage is ADDITIVE METADATA on the dispute row (Andrew's
 * S298 ack: "additive metadata, no new rows" — a table would be a second
 * spine; the `claim_case_events` ledger owns SEQUENCE, this owns CONTENT).
 * `sent_letter` (S74.5) stays the untouched current-artifact column — every
 * existing consumer keeps working; this stack exists so an UNSENT snapshot is
 * retained and labeled instead of silently orphaned (§0.9b: "Marked sent
 * «date», then unsent — never mailed", never again rendered as mailed).
 *
 * Writers: the outcome route's mark-sent (bank) + unsend (stamp) paths — the
 * same sites that emit letter_sent / letter_unsent. One writer family, one
 * reader (the letter page's version box), no drift.
 *
 * PURE — exercised by scripts/calibration/fixtures/dispute-grounds/sent-versions.ts.
 */

export interface SentVersionEntry {
  /** The letter body exactly as it was marked sent. */
  body: string;
  /** Server-stamped mark-as-sent time (ISO). */
  sentAt: string;
  /** Present when this version was unsent — never mailed (§0.9b label). */
  unsentAt?: string;
}

function entries(meta: Record<string, unknown> | null | undefined): SentVersionEntry[] {
  const raw = (meta ?? {}).sentVersions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is SentVersionEntry =>
      e != null &&
      typeof e === "object" &&
      typeof (e as { body?: unknown }).body === "string" &&
      typeof (e as { sentAt?: unknown }).sentAt === "string",
  );
}

/** Read the stack (defensive; [] on legacy rows). */
export function readSentVersions(
  meta: Record<string, unknown> | null | undefined,
): SentVersionEntry[] {
  return entries(meta);
}

/**
 * Bank a new sent version at mark-as-sent. Idempotent against double-submits:
 * if the latest entry is un-unsent with the identical body, it is refreshed in
 * place (sentAt updates) instead of duplicated.
 */
export function bankSentVersion(
  meta: Record<string, unknown> | null | undefined,
  body: string,
  sentAtIso: string,
): Record<string, unknown> {
  const base = { ...(meta ?? {}) };
  const stack = entries(base);
  const last = stack[stack.length - 1];
  const next =
    last && last.unsentAt == null && last.body === body
      ? [...stack.slice(0, -1), { ...last, sentAt: sentAtIso }]
      : [...stack, { body, sentAt: sentAtIso }];
  return { ...base, sentVersions: next };
}

/**
 * Stamp the latest un-unsent version at unsend (§0.9b: the snapshot is
 * RETAINED, labeled, never again rendered as a mailed letter). No-op when
 * nothing is outstanding (legacy rows that were sent before banking existed).
 */
export function stampUnsent(
  meta: Record<string, unknown> | null | undefined,
  unsentAtIso: string,
): Record<string, unknown> {
  const base = { ...(meta ?? {}) };
  const stack = entries(base);
  const idx = [...stack].reverse().findIndex((e) => e.unsentAt == null);
  if (idx === -1) return base;
  const realIdx = stack.length - 1 - idx;
  const next = stack.map((e, i) => (i === realIdx ? { ...e, unsentAt: unsentAtIso } : e));
  return { ...base, sentVersions: next };
}
