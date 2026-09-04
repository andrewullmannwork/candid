/**
 * content-disposition — build a Content-Disposition header that cannot throw
 * and does not silently mangle a name (S331).
 *
 * HTTP header values are ByteStrings: every character must fit in a byte. A
 * filename carrying an em dash, an accent or a curly quote makes the runtime
 * throw when the response is constructed — "Cannot convert argument to a
 * ByteString because the character at index N has a value of 8212" — which is
 * how the DFY submission packet failed: its filename was
 * "Appeal submission packet — 50db0cf0.pdf".
 *
 * The routes that got this right did so by accident, sanitising down to
 * `[a-z0-9-]` — safe, but it also quietly strips a member's accented name out
 * of the file they receive. RFC 6266/5987 has the actual answer: an ASCII
 * `filename` for every client, plus a percent-encoded UTF-8 `filename*` that
 * modern clients prefer. Both are emitted here, so the name survives when it
 * can and degrades predictably when it cannot.
 */

/** ASCII-only, quote-safe, no control characters — the `filename` fallback. */
function asciiFallback(name: string): string {
  const stripped = name
    // Common typography → its ASCII equivalent, so the fallback still reads.
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    // Anything left outside printable ASCII goes.
    .replace(/[^\x20-\x7E]/g, "")
    // Quotes and backslashes would break out of the quoted-string.
    .replace(/["\\]/g, "")
    .trim();
  return stripped.length > 0 ? stripped : "download";
}

/**
 * @param fileName the human name, in full Unicode
 * @param disposition "attachment" (save) or "inline" (render in the tab)
 */
export function contentDisposition(
  fileName: string,
  disposition: "attachment" | "inline" = "attachment",
): string {
  const ascii = asciiFallback(fileName);
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
