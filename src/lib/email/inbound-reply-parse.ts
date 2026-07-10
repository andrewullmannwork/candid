/**
 * Pure parsing helpers for the inbound support-email → Slack loop
 * (`/api/email-forward`). Kept separate from the route so the bug-prone bits
 * (quoted-history stripping, ticket-id range, From parsing) are unit-testable.
 * No I/O, no side effects.
 */

/** "Name <a@b.com>" → "a@b.com" (lowercased, trimmed). */
export function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** Redact an address for logs: "andrew.david@gmail.com" → "a***@gmail.com". */
export function redactEmail(email: string): string {
  return email.replace(/^(.).*?(@.*)$/, "$1***$2");
}

/** Our own senders + common bounce/auto-reply patterns — never loop these. */
export function isLoopOrBounce(senderEmail: string, subject: string): boolean {
  if (senderEmail.endsWith("@candidclaim.com")) return true; // our own outbound
  if (/^(mailer-daemon|postmaster|no-?reply)@/i.test(senderEmail)) return true;
  return /^(auto(matic)?[- ]?reply|out of office|undeliverable|undelivered mail|delivery status notification|returned mail|read receipt)/i.test(
    subject.trim(),
  );
}

/**
 * Pull the #CN-XXXXX ticket ref out of the subject (5 hex, uppercased).
 * Case-insensitive on the `#CN-` prefix — some clients lowercase the subject on
 * reply; the captured id is uppercased to match the stored ticket shortId.
 */
export function extractShortId(subject: string): string | null {
  const m = subject.match(/#CN-([A-Za-z0-9]{5})/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Strip the quoted-history trailer from a plaintext reply, keeping only the new
 * text the user typed. Heuristic — covers the common clients (Gmail/Apple/
 * Outlook). Inbound reply parsing is never perfect, but the reply is billing/
 * plan support text, not structured data.
 */
export function stripQuotedReply(text: string): string {
  const markers = [
    /^On .+ wrote:$/, // Gmail / Apple Mail
    /^-{2,}\s*Original Message\s*-{2,}/i,
    /^_{5,}/, // Outlook divider
    /^From:\s.+/, // Outlook quoted header block
    /^>/, // quoted line
    /^Replying to ticket #CN-/, // our own outbound trailer
  ];
  const lines = text.split(/\r?\n/);
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (markers.some((re) => re.test(trimmed))) {
      cut = i;
      break;
    }
  }
  return lines.slice(0, cut).join("\n").trim();
}

/**
 * UUID prefix range for a 5-hex shortId — an index-friendly ticket lookup (the
 * shortId is the first 5 hex of the ticket UUID, which are the first 5 chars of
 * the UUID text). Returns [lo, hi) bounds; hi is null only for the degenerate
 * all-F prefix (fall back to lo-only + exact code check).
 */
export function shortIdRange(shortId: string): { lo: string; hi: string | null } {
  const p = shortId.toLowerCase();
  const lo = `${p.padEnd(8, "0")}-0000-0000-0000-000000000000`;
  const n = parseInt(p, 16);
  if (!Number.isFinite(n) || n >= 0xfffff) return { lo, hi: null };
  const hiPrefix = (n + 1).toString(16).padStart(5, "0");
  return { lo, hi: `${hiPrefix.padEnd(8, "0")}-0000-0000-0000-000000000000` };
}
