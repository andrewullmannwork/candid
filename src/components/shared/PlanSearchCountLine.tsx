/**
 * S316 — the ONE results-count line for every plan-search list. Replaces four
 * hand-rolled copies (check page, compare PlanSlot, ComparePickerV2,
 * onboarding doc-step search), each gated `> 25` — which left short-but-
 * scrolling lists (the boxes overflow at ~5 rows) with no cue that more
 * plans sat below the fold or that typing more would narrow the set
 * (Andrew, S316: "we need copy or clearer signal… across ALL surfaces").
 *
 * Render it as the FIRST child of the scroll container — it's sticky.
 * `total` is the route's pre-clamp count (the S315 honesty rule: a count
 * line's truth needs the pre-clamp total, not the shown length).
 */
export function PlanSearchCountLine({
  shown,
  total,
  minForHint = 6,
}: {
  shown: number;
  total: number;
  /** Rows visible before the box scrolls (~5 at max-h-72); at or above this
   *  the scroll cue shows even when nothing was truncated. */
  minForHint?: number;
}) {
  if (shown <= 0) return null;
  const truncated = total > shown;
  if (!truncated && shown < minForHint) return null;
  return (
    <div className="sticky top-0 z-10 border-b border-gray-100 bg-gray-50/95 px-4 py-1.5 text-[11px] font-medium text-gray-500">
      {truncated
        ? `Showing ${shown} of ${total} matches — keep typing to narrow.`
        : `${shown} plan${shown === 1 ? "" : "s"} match — scroll to see all, or keep typing to narrow.`}
    </div>
  );
}
