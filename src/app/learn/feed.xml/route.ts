import { listArticles } from "@/lib/learn/articles";
import { AUTHOR } from "@/lib/learn/author";

/**
 * Atom feed for /learn — the machine-readable "what's new" list.
 *
 * This is the one standard discovery surface the site was missing. Newsletter
 * tooling, readers/aggregators, and several AI crawlers poll feeds to find new
 * content; without one, they only ever find a new guide by stumbling across it.
 * Atom over RSS 2.0 for unambiguous dates (RFC 3339) and required IDs.
 *
 * Static: `listArticles()` reads the repo at build time, exactly like the
 * sitemap, so this costs nothing at request time.
 */

const ORIGIN = "https://www.candidclaim.com";
export const dynamic = "force-static";

/** XML-escape text nodes. Titles carry apostrophes and ampersands. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** YYYY-MM-DD → RFC 3339. Noon UTC so the date cannot slide a day west. */
function rfc3339(date: string): string {
  return `${date}T12:00:00Z`;
}

export function GET() {
  const articles = listArticles();

  // Feed-level timestamp = the most recently updated guide, not "now": a feed
  // that claims to change every time it is fetched teaches pollers to ignore it.
  const updated = articles
    .map((a) => a.last_updated)
    .sort()
    .reverse()[0];

  const entries = articles
    .map(
      (article) => `  <entry>
    <title>${xml(article.title)}</title>
    <link href="${ORIGIN}/learn/${article.slug}" />
    <id>${ORIGIN}/learn/${article.slug}</id>
    <published>${rfc3339(article.published)}</published>
    <updated>${rfc3339(article.last_updated)}</updated>
    <author><name>${xml(AUTHOR.name)}</name><uri>${ORIGIN}${AUTHOR.path}</uri></author>
    <summary type="text">${xml(article.description)}</summary>
  </entry>`,
    )
    .join("\n");

  const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Candid Guides</title>
  <subtitle>Step-by-step guides to understand your medical bills, dispute incorrect charges, and negotiate your total medical cost down.</subtitle>
  <link href="${ORIGIN}/learn/feed.xml" rel="self" />
  <link href="${ORIGIN}/learn" />
  <id>${ORIGIN}/learn</id>
  <updated>${rfc3339(updated)}</updated>
  <author><name>${xml(AUTHOR.name)}</name><uri>${ORIGIN}${AUTHOR.path}</uri></author>
  <rights>© ${new Date().getFullYear()} Airgetlam Labs LLC</rights>
${entries}
</feed>
`;

  return new Response(feed, {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
