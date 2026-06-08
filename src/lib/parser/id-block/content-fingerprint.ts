/**
 * ID-Block — content fingerprint (the §3.1 TRIGGER).
 *
 * A 64-bit simhash over normalized OCR-text 3-word shingles, rendered as a
 * lowercase 16-char hex string. Purpose: recognize when N corroborating uploads
 * are the SAME document (re-save / minor-OCR-variance invariant) so the
 * corroboration gate can route that cluster to the cluster-legitimacy gate. NEVER a
 * reject on its own — provider-distributed SBCs are byte-identical across real
 * members (§3.1). `documents.file_hash` (SHA-256 of bytes) already covers
 * byte-identical; this adds re-save invariance.
 *
 * Comparisons are ALWAYS within a single value-tuple promotion cluster (same
 * deductibles / OOP), so shared insurer boilerplate across DIFFERENT plans never
 * collides — different plans land in different clusters and are never compared.
 *
 * CONSTRUCTION PARAMS ARE PINNED (ALGO_VERSION), not flag-tunable: changing the
 * shingle size / normalization / hash would make new fingerprints incomparable with
 * stored ones. Only the GATE thresholds (the Hamming near-dup cutoff, the legitimacy
 * weights/thresholds) are flag-tunable (id-block/config.ts, Ship Gate G6). If a
 * construction param must change, bump ALGO_VERSION and re-run the backfill over all
 * rows (scripts/id-block/fingerprint-backfill.ts).
 *
 * Hot-path safety: the per-shingle hash is two 32-bit FNV-1a (no BigInt in the loop,
 * no crypto import) — cost is <2% of a parse that already runs OCR + Haiku.
 *
 * Fixture-locked (Ship Gate G4): scripts/calibration/fixtures/id-block/content-fingerprint.fixture.ts
 * SoT: plans/id-block-corroboration-source-independence.md §3.1 + §9.2.
 */

/** Pinned construction version. Bump + re-backfill if any param below changes. */
export const ALGO_VERSION = 1 as const;

/** Word-level shingle size (pinned). */
const SHINGLE_SIZE = 3;

/** FNV-1a 32-bit constants. Two distinct offset bases → two semi-independent 32-bit hashes. */
const FNV_OFFSET_A = 0x811c9dc5; // standard 2166136261
const FNV_OFFSET_B = 0x01234567; // distinct seed for the high word
const FNV_PRIME = 0x01000193; // 16777619

/**
 * Normalize OCR text for shingling: NFKC fold, lowercase, every run of
 * non-alphanumeric collapses to a single space, trim. Digits are KEPT (cost
 * scalars), but within-cluster comparison means they don't drive false matches.
 */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** FNV-1a 32-bit over a string from a seed offset basis. Stays in uint32 via Math.imul. */
function fnv1a32(s: string, offset: number): number {
  let h = offset | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * Compute the content fingerprint. Returns null when there is no usable text (empty
 * after normalization) — a doc with no text contributes no fingerprint.
 */
export function computeContentFingerprint(rawText: string): string | null {
  const norm = normalize(rawText);
  if (norm.length === 0) return null;
  const words = norm.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) return null;

  // Build k-word shingles. For docs shorter than k words, the single shingle is the
  // whole word list — still deterministic.
  const shingles: string[] = words.length < SHINGLE_SIZE ? [words.join(" ")] : [];
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    shingles.push(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }

  // Simhash bit accumulators (index 0..31 = low word, 32..63 = high word).
  const v = new Int32Array(64);
  for (const sh of shingles) {
    const low = fnv1a32(sh, FNV_OFFSET_A);
    const high = fnv1a32(sh, FNV_OFFSET_B);
    for (let b = 0; b < 32; b++) {
      v[b] += (low >>> b) & 1 ? 1 : -1;
      v[b + 32] += (high >>> b) & 1 ? 1 : -1;
    }
  }

  // Collapse to the 64-bit signature → two uint32 halves → hex16.
  let low = 0;
  let high = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b] > 0) low |= 1 << b;
    if (v[b + 32] > 0) high |= 1 << b;
  }
  const hex = (x: number) => (x >>> 0).toString(16).padStart(8, "0");
  return hex(high) + hex(low);
}

/** Popcount of a 32-bit integer. */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24);
}

/**
 * Hamming distance (number of differing bits, 0..64) between two 16-char hex
 * fingerprints. Returns 64 (maximally distant) if EITHER is null/malformed — a
 * parse failure must never read as "same document".
 */
export function hammingDistance(a: string | null, b: string | null): number {
  if (!a || !b) return 64;
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64;
  const aHigh = parseInt(a.slice(0, 8), 16);
  const aLow = parseInt(a.slice(8, 16), 16);
  const bHigh = parseInt(b.slice(0, 8), 16);
  const bLow = parseInt(b.slice(8, 16), 16);
  return popcount32(aHigh ^ bHigh) + popcount32(aLow ^ bLow);
}
