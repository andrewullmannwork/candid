/**
 * Regression smoke for the inbound support-email → Slack parse helpers
 * (`src/lib/email/inbound-reply-parse.ts`). Pure-logic assertions; no I/O.
 *
 * Run: npx tsx scripts/support-inbound-parse-smoke.ts
 * Exits non-zero on any failure.
 */
import {
  extractEmail,
  redactEmail,
  isLoopOrBounce,
  extractShortId,
  stripQuotedReply,
  shortIdRange,
} from "../src/lib/email/inbound-reply-parse";

let fails = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

// extractEmail
eq("extractEmail display-name", extractEmail("Andrew Ullmann <Andrew.David.Ullmann@Gmail.com>"), "andrew.david.ullmann@gmail.com");
eq("extractEmail bare", extractEmail("  plain@X.com "), "plain@x.com");

// redactEmail
eq("redactEmail", redactEmail("andrew.david.ullmann@gmail.com"), "a***@gmail.com");

// isLoopOrBounce
eq("loop own domain", isLoopOrBounce("support@candidclaim.com", "Re: [#CN-96BC2] x"), true);
eq("loop mailer-daemon", isLoopOrBounce("mailer-daemon@googlemail.com", "Delivery failure"), true);
eq("bounce auto-reply subject", isLoopOrBounce("user@gmail.com", "Automatic reply: Out of office"), true);
eq("normal user passes", isLoopOrBounce("user@gmail.com", "Re: [#CN-96BC2] Slack Test"), false);

// extractShortId (case-insensitive on the #CN- prefix)
eq("shortId basic", extractShortId("Re: [#CN-96BC2] Slack Test"), "96BC2");
eq("shortId lowercased subject", extractShortId("re: [#cn-a1b2c] foo"), "A1B2C");
eq("shortId none", extractShortId("no ticket ref here"), null);

// stripQuotedReply — Gmail
const gmail = `Thanks, that makes sense. One more question — is the copay waived?

On Fri, Jul 10, 2026 at 12:00 PM Candid Support <support@candidclaim.com> wrote:

> Hi Andrew, here's the info...
> — Candid Support
> ---
> Replying to ticket #CN-96BC2. Reply to this email to keep the conversation going.`;
eq("strip gmail", stripQuotedReply(gmail), "Thanks, that makes sense. One more question — is the copay waived?");

// stripQuotedReply — Outlook divider
const outlook = `My reply here.

________________________________
From: Candid Support <support@candidclaim.com>
Sent: Friday, July 10, 2026 12:00 PM`;
eq("strip outlook", stripQuotedReply(outlook), "My reply here.");

// stripQuotedReply — no quote
eq("strip none", stripQuotedReply("Just a plain reply.\nSecond line."), "Just a plain reply.\nSecond line.");

// shortIdRange — brackets the real ticket id + carry + degenerate
const r = shortIdRange("96BC2");
eq("range lo", r.lo, "96bc2000-0000-0000-0000-000000000000");
eq("range hi", r.hi, "96bc3000-0000-0000-0000-000000000000");
const realId = "96bc2054-864b-4325-aecf-904023034715";
eq("real id in [lo,hi)", realId >= r.lo && r.hi !== null && realId < r.hi, true);
eq("range carry hi", shortIdRange("9FFFF").hi, "a0000000-0000-0000-0000-000000000000");
eq("range allF hi null", shortIdRange("FFFFF").hi, null);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
