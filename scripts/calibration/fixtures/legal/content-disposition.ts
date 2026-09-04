/**
 * content-disposition — S331. Locks the header that broke the DFY submission
 * packet.
 *
 * The failure: the packet's filename was "Appeal submission packet — …pdf" and
 * the em dash (U+2014, 8212) cannot fit in a byte. Constructing the response
 * threw, and the operator saw only "Couldn't build the packet".
 *
 *   1. EVERY byte of the header is latin-1 representable — the property whose
 *      absence caused the crash, asserted over the characters that actually
 *      show up in these names
 *   2. the ASCII fallback stays readable (typography degrades to its ASCII
 *      equivalent rather than vanishing)
 *   3. the full Unicode name still survives, via RFC 5987 filename*
 *   4. quotes and backslashes cannot break out of the quoted-string
 *   5. a name that sanitises to nothing still yields a usable filename
 *
 * Run: npx tsx scripts/calibration/fixtures/legal/content-disposition.ts
 */
import { contentDisposition } from "../../../../src/lib/http/content-disposition";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}`); } }

/** The property the runtime enforces when it builds a response. */
function isByteString(v: string): boolean {
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) > 255) return false;
  return true;
}

// 1 — the crash itself
const THE_NAME = "Appeal submission packet — 50db0cf0.pdf";
check("the exact filename that crashed the packet is now header-safe",
  isByteString(contentDisposition(THE_NAME)));
check("an em dash alone is header-safe", isByteString(contentDisposition("a — b.pdf")));

const NASTY = [
  "Appeal submission packet — 50db0cf0.pdf",
  "Désignation du représentant.pdf",
  "案件ファイル.pdf",
  "Smith’s appeal “final”.pdf",
  "ellipsis….pdf",
  'quote"and\\backslash.pdf',
  "emoji 📄.pdf",
  "  ",
];
for (const n of NASTY) {
  check(`header stays a ByteString for ${JSON.stringify(n)}`, isByteString(contentDisposition(n)));
  check(`inline form too for ${JSON.stringify(n)}`, isByteString(contentDisposition(n, "inline")));
}

// 2 — the fallback still reads
check("an em dash degrades to a hyphen, not nothing",
  /Appeal submission packet - 50db0cf0\.pdf/.test(contentDisposition(THE_NAME)));
check("curly quotes degrade to straight ones",
  contentDisposition("Smith’s.pdf").includes("Smith's.pdf"));
check("an ellipsis degrades to dots",
  contentDisposition("wait….pdf").includes("wait....pdf"));

// 3 — the real name survives for clients that can take it
check("the UTF-8 name is carried in filename*",
  contentDisposition("Désignation.pdf").includes("filename*=UTF-8''D%C3%A9signation.pdf"));
check("a fully non-ASCII name still round-trips in filename*",
  decodeURIComponent(contentDisposition("案件.pdf").split("filename*=UTF-8''")[1]) === "案件.pdf");

// 4 — the quoted-string cannot be broken out of
const q = contentDisposition('a"b\\c.pdf');
check("quotes are removed from the fallback", !/filename="[^"]*"[^;]/.test(q));
check("no backslash survives in the fallback",
  !(q.split('filename="')[1] ?? "").split('"')[0].includes("\\"));

// 5 — never an empty filename
check("a blank name still yields something usable",
  contentDisposition("   ").includes('filename="download"'));
check("a name of only emoji still yields something usable",
  contentDisposition("📄📄").includes('filename="download"'));

// disposition type
check("attachment is the default", contentDisposition("x.pdf").startsWith("attachment;"));
check("inline is honoured", contentDisposition("x.pdf", "inline").startsWith("inline;"));

console.log(`content-disposition: ${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
