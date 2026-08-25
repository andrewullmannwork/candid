/**
 * IndexNow submission — push published URLs to the participating search engines.
 *
 * WHY THIS EXISTS. IndexNow was specified in the content distribution plan and
 * never built. Meanwhile Bing has held a pre-launch snapshot of the site with
 * ZERO content pages indexed for over three weeks, diagnosed clean on our side
 * (robots allows Bingbot, the sitemap is declared and correct, `/learn` serves
 * 200 to a Bingbot UA). IndexNow is the push channel that does not wait for a
 * crawler to come back on its own schedule.
 *
 * ⚠ GOOGLE DOES NOT PARTICIPATE IN INDEXNOW. This moves Bing, Yandex, Seznam
 * and Naver — the engines that share the protocol. That is still worth doing
 * because BING'S INDEX FEEDS CHATGPT AND COPILOT, so a Bing outage is an
 * AI-visibility outage too. Google stays on sitemap + Search Console.
 *
 * WHY A SCRIPT AND NOT A ROUTE OR A BUILD HOOK. Publishing here is wave-based
 * and deliberate (sync the vault → PR → promote). A runtime endpoint would add
 * an unauthenticated surface for no gain, and a build hook would fire on every
 * deploy — including the many that change no content — which is exactly the
 * spammy pattern the engines throttle. A script run after a promote matches
 * the motion that actually exists.
 *
 * THE KEY IS PUBLIC BY DESIGN. Ownership is proven by hosting the key at
 * `<host>/<key>.txt`, so the key file is committed on purpose. It lives in
 * `public/` — but note that `public/` is NOT automatically public here: the
 * middleware matches every path except `_next/*` and `favicon.ico` and
 * auth-walls whatever it does not explicitly allow. The key file 307'd to the
 * landing page until it was added to the middleware allowlist, and because
 * that redirect answers 200 with HTML, the failure is silent unless you check
 * the CONTENTS. `verifyKeyFile` below checks the contents.
 *
 * Run:
 *   npx tsx scripts/seo/indexnow-submit.ts [--host=<host>] [--dry-run] [url ...]
 *
 *   --dry-run  print exactly what would be submitted, send nothing.
 *   url ...    submit only these URLs; default is every URL in the live sitemap.
 */

import { INDEXNOW_KEY as KEY } from "@/lib/seo/indexnow";

const DEFAULT_HOST = "www.candidclaim.com";
const ENDPOINT = "https://api.indexnow.org/indexnow";

/** IndexNow accepts at most 10,000 URLs per request. */
const MAX_URLS = 10_000;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/**
 * The sitemap is the authority on what is published — deriving the URL list
 * from it (rather than from a local file walk) means we can only ever announce
 * pages the live site actually serves.
 */
async function urlsFromSitemap(host: string): Promise<string[]> {
  const sitemapUrl = `https://${host}/sitemap.xml`;
  const res = await fetch(sitemapUrl, { redirect: "follow" });
  if (!res.ok) fail(`sitemap fetch failed: ${res.status} ${res.statusText} (${sitemapUrl})`);

  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (locs.length === 0) fail(`no <loc> entries found in ${sitemapUrl}`);
  return [...new Set(locs)];
}

/**
 * Every URL must be on the submitting host or the whole batch is rejected with
 * a 422 — so this is checked here, where the offending URL can be named, and
 * not left to a rejection that says only "some URL didn't belong".
 */
function assertSameHost(urls: string[], host: string): void {
  const foreign = urls.filter((u) => {
    try {
      return new URL(u).host !== host;
    } catch {
      return true;
    }
  });
  if (foreign.length > 0) {
    fail(`${foreign.length} URL(s) are not on ${host}, which would 422 the batch:\n  ${foreign.slice(0, 5).join("\n  ")}`);
  }
}

async function verifyKeyFile(host: string): Promise<void> {
  const keyUrl = `https://${host}/${KEY}.txt`;
  const res = await fetch(keyUrl, { redirect: "follow" });
  if (!res.ok) {
    fail(`key file is not reachable: ${res.status} ${res.statusText}\n  ${keyUrl}\n  Deploy before submitting — an unreachable key fails validation.`);
  }
  const body = (await res.text()).trim();
  if (body !== KEY) {
    fail(`key file served the wrong contents (got ${body.length} chars, expected the 64-char key).\n  ${keyUrl}\n  A 307 to the landing page looks like this — check the middleware matcher.`);
  }
  console.log(`  key file verified: ${keyUrl}`);
}

async function main(): Promise<void> {
  const host = arg("host") ?? DEFAULT_HOST;
  const dryRun = process.argv.includes("--dry-run");
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  console.log(`\nIndexNow submission`);
  console.log(`  host:     ${host}`);
  console.log(`  engines:  Bing · Yandex · Seznam · Naver  (NOT Google)`);

  const urls = explicit.length > 0 ? explicit : await urlsFromSitemap(host);
  assertSameHost(urls, host);
  if (urls.length > MAX_URLS) fail(`${urls.length} URLs exceeds the ${MAX_URLS}-URL per-request limit`);

  console.log(`  source:   ${explicit.length > 0 ? "explicit arguments" : `https://${host}/sitemap.xml`}`);
  console.log(`  urls:     ${urls.length}`);
  for (const u of urls) console.log(`    ${u}`);

  if (dryRun) {
    console.log(`\n— dry run: nothing submitted —\n`);
    return;
  }

  await verifyKeyFile(host);

  const payload = {
    host,
    key: KEY,
    keyLocation: `https://${host}/${KEY}.txt`,
    urlList: urls,
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });

  // The protocol distinguishes "accepted" from "accepted but the key is still
  // being validated" — both are successes, and conflating them would hide a
  // key problem that only shows up as silence days later.
  const meaning: Record<number, string> = {
    200: "OK — URLs submitted",
    202: "Accepted — URLs received, key validation pending",
    400: "Bad request — invalid format",
    403: "Forbidden — key not valid for this host",
    422: "Unprocessable — a URL does not belong to this host, or the key does not match",
    429: "Too many requests — throttled; wait before retrying",
  };
  const note = meaning[res.status] ?? "unexpected status";
  const body = await res.text();

  console.log(`\n  response: ${res.status} — ${note}`);
  if (body.trim()) console.log(`  body:     ${body.trim().slice(0, 400)}`);

  if (res.status !== 200 && res.status !== 202) {
    fail(`submission was not accepted (${res.status})`);
  }
  console.log(`\n✓ ${urls.length} URL(s) submitted to IndexNow\n`);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
