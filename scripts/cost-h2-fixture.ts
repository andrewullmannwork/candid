/* Cost-H.2 (S198) fixture — pure-logic assertions for the launch-UX block.
 * Runnable: npx tsx scripts/cost-h2-fixture.ts
 *
 * Proves:
 *   (D3) haikuUsageCostUsd prices at the corrected Haiku 4.5 rates incl. cache classes.
 *   (D1) classifyAsyncDocTier two-tier semantics — behavior-neutral at 30/30, the
 *        15/30 split (the future 15-30 "splash-no-email" band), + isPdf/async gating.
 *   Flag defaults are 30/30 → the S198 ship is behavior-neutral.
 *
 * CI-wiring is a follow-up obligation (Ship Gate G4); manually runnable today.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "../.env.local"), override: false });
import { haikuUsageCostUsd } from "@/lib/haiku-client/base";
import { classifyAsyncDocTier, FLAGS } from "@/lib/config/feature-flags";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

// ── D3: haikuUsageCostUsd ($1 in / $5 out / $0.10 cache-read / +25% cache-write) ──
check("cost: 1000 in + 500 out = $0.0035",
  near(haikuUsageCostUsd({ input_tokens: 1000, output_tokens: 500 }), 0.0035));
check("cost: cache-READ 8000 (+100 in +500 out) = $0.0034",
  near(haikuUsageCostUsd({ input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 8000 }), 0.0034));
check("cost: cache-WRITE 8000 (+100 in +500 out) = $0.0126",
  near(haikuUsageCostUsd({ input_tokens: 100, output_tokens: 500, cache_creation_input_tokens: 8000 }), 0.0126));
check("cost: empty usage = $0", near(haikuUsageCostUsd({}), 0));
check("cost: null usage = $0", near(haikuUsageCostUsd(null), 0));
check("cost: cache-read is the win (read 12x < write, same tokens)",
  haikuUsageCostUsd({ cache_read_input_tokens: 10000 }) * 12 < haikuUsageCostUsd({ cache_creation_input_tokens: 10000 }));

// ── D1: classifyAsyncDocTier ──
const PDF = { isPdf: true, asyncEnabled: true } as const;
// Behavior-neutral at default 30/30: for PDFs, isLargeDoc == willEmail (both gate at 30)
for (const p of [10, 30, 31, 50, 200]) {
  const t = classifyAsyncDocTier({ pageCount: p, redirectMaxPages: 30, emailMaxPages: 30, ...PDF });
  check(`default 30/30 neutral @${p}p: isLargeDoc==willEmail`, t.isLargeDoc === t.willEmail, JSON.stringify(t));
}
check("default 30/30 @30p: neither (boundary → sync screen)",
  (() => { const t = classifyAsyncDocTier({ pageCount: 30, redirectMaxPages: 30, emailMaxPages: 30, ...PDF }); return !t.isLargeDoc && !t.willEmail; })());
check("default 30/30 @31p: splash + email (= today's >30 behavior)",
  (() => { const t = classifyAsyncDocTier({ pageCount: 31, redirectMaxPages: 30, emailMaxPages: 30, ...PDF }); return t.isLargeDoc && t.willEmail; })());
// Future 15/30 split (post frontend §R.2)
check("15/30 @10p: sync (neither)",
  (() => { const t = classifyAsyncDocTier({ pageCount: 10, redirectMaxPages: 15, emailMaxPages: 30, ...PDF }); return !t.isLargeDoc && !t.willEmail; })());
check("15/30 @20p: splash WITHOUT email (the new 15-30 band)",
  (() => { const t = classifyAsyncDocTier({ pageCount: 20, redirectMaxPages: 15, emailMaxPages: 30, ...PDF }); return t.isLargeDoc && !t.willEmail; })());
check("15/30 @35p: splash WITH email",
  (() => { const t = classifyAsyncDocTier({ pageCount: 35, redirectMaxPages: 15, emailMaxPages: 30, ...PDF }); return t.isLargeDoc && t.willEmail; })());
// Gating: non-PDF + async-off never get the splash
check("non-PDF @50p: no splash (isPdf gate)",
  !classifyAsyncDocTier({ pageCount: 50, isPdf: false, asyncEnabled: true, redirectMaxPages: 15, emailMaxPages: 30 }).isLargeDoc);
check("async-off @50p: no splash (flag gate)",
  !classifyAsyncDocTier({ pageCount: 50, isPdf: true, asyncEnabled: false, redirectMaxPages: 15, emailMaxPages: 30 }).isLargeDoc);

// ── Flag defaults: ship is behavior-neutral (both 30) ──
check("FLAGS.ASYNC_REDIRECT_MAX_PAGES default 30", FLAGS.ASYNC_REDIRECT_MAX_PAGES === 30, `got ${FLAGS.ASYNC_REDIRECT_MAX_PAGES}`);
check("FLAGS.ASYNC_EMAIL_MAX_PAGES default 30", FLAGS.ASYNC_EMAIL_MAX_PAGES === 30, `got ${FLAGS.ASYNC_EMAIL_MAX_PAGES}`);

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
