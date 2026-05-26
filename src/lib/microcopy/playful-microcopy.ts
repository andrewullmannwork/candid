/**
 * Rotating brand-voice microcopy — the doctor's-office-vignette message list
 * shown under all parse/audit/dispute-draft loaders.
 *
 * Recovered S131 (B-LOAD.1) from `b9d75c5:src/components/parsing/PlayfulParsingScreen.tsx`
 * (S93 PR #81). PlayfulParsingScreen was deleted in S101 PR #82 when ProcessingFlow
 * unified the loader surface; the 55-line microcopy list was lost in the rename.
 *
 * S70 = 15 lines · S93 expansion = 55 lines (covers ~3min 40s loop at 4000ms
 * rotation interval without visible repetition for typical 2-4 min parse cycles).
 *
 * Tone discipline (preserved verbatim from S93 codification):
 *   - Whimsical doctor's-office vignettes
 *   - Concrete + visual + light
 *   - Never reveal mechanics ("we're tokenizing CPT codes" = banned)
 *   - No marketing fluff
 *
 * Consumers:
 *   - StackLoaderV3 (plan + document upload flow at /upload + /compare)
 *   - CodeCarouselLoaderV3 (audit flow: /claim navigation + dispute drafting)
 *
 * CubeLoaderBuilding does NOT consume — it's a navigation transition cue with
 * no rotating-message slot (pure visual signal).
 */

export const ROTATING_MICROCOPY: string[] = [
  // S70 original 15
  "Taking a pen from behind our ear.",
  "Adjusting the reading lamp on our desk.",
  "Sliding glasses down to the tip of our nose.",
  "Doodling a tiny stethoscope in the margin.",
  "Sharpening a #2 pencil. Just the way we like it.",
  "Highlighting the important bits in yellow.",
  "Adding a sticky note for later.",
  "Pouring a fresh cup of coffee.",
  "Stacking the pages. Aligning pens.",
  "Underlining the fine print twice.",
  "Tapping the desk thoughtfully.",
  "Cross-referencing with the big binder on the shelf.",
  "Drawing a little arrow next to the most important number.",
  "Stamping a smiley face in the corner.",
  "Almost done. Just polishing the apple on the desk.",
  // S93 expansion (40 new)
  "Squinting at the small print.",
  "Reaching for the second pair of glasses.",
  "Untangling the phone cord.",
  "Filing the folder under “important.”",
  "Wiping a smudge off the desk lamp.",
  "Tearing a fresh page from the notepad.",
  "Clicking the pen twice. Just to be sure.",
  "Pinning a note to the corkboard.",
  "Sliding the manila folder open.",
  "Counting the pages a second time.",
  "Refilling the stapler.",
  "Erasing a faint pencil mark.",
  "Fluffing the cushion on the rolling chair.",
  "Straightening the diploma on the wall.",
  "Watering the office fern.",
  "Reading aloud, just to ourselves.",
  "Reaching for the calculator.",
  "Adjusting the desk fan.",
  "Folding a paper airplane out of habit.",
  "Squaring the corners of the stack.",
  "Writing “TBD” then scratching it out.",
  "Locating the missing paperclip.",
  "Tapping the stapler. Empty.",
  "Refilling the coffee pot.",
  "Brushing crumbs off the manila folder.",
  "Glancing at the wall clock.",
  "Lining up the post-it notes.",
  "Drawing a star next to the deductible.",
  "Re-reading the appendix, just in case.",
  "Cracking our knuckles.",
  "Switching from blue ink to red.",
  "Spotting the typo on page three.",
  "Sliding a bookmark into the right spot.",
  "Sketching a tiny clipboard in the margin.",
  "Whispering “interesting” under our breath.",
  "Wiping the magnifying glass clean.",
  "Shuffling the pages back into order.",
  "Pinning the receipt to the rest.",
  "Folding down the corner of page seven.",
  "Smiling at the well-organized notes.",
];

/**
 * Rotation interval for the message rotator. 4000ms matches the original S93
 * cadence — slow enough to read, fast enough to feel alive. 55 lines × 4s =
 * ~3min 40s loop, covers typical parse latency without visible repetition.
 *
 * Note: the SEPARATE page-counter random-tick mechanic ({3,5,7,10}s) at
 * `src/lib/parsing/parseProgressUx.ts` is unaffected — only the message
 * rotator runs on this constant.
 */
export const MICROCOPY_INTERVAL_MS = 4000;
