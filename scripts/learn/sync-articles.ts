/**
 * /learn publish transform — vault editorial copies → `content/learn/*.md`.
 *
 * The vault (`01_Inbox/Candid_GTM/articles/Approved-*.md`) is the editorial
 * source of truth; this script produces the published artifact. It is
 * idempotent and regenerates the ENTIRE published set every run, which is the
 * point: when a later wave publishes, re-running lights up the cross-links
 * that earlier waves had to degrade to plain text, with no manual backfill.
 *
 * Run: `npx tsx scripts/learn/sync-articles.ts [--vault=<dir>] [--date=YYYY-MM-DD] [--check]`
 *   --check  verify the working tree matches what this script would write,
 *            without touching any file (exit 1 on drift).
 *
 * Publishing a wave = add its basenames to PUBLISHED below and re-run.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const VAULT_DEFAULT =
  "/Users/andrewullmann/Desktop/du_weldenvarden/01_Inbox/Candid_GTM/articles";

const CONTENT_DIR = join(process.cwd(), "content/learn");

/**
 * The published set, in wave order. Source basenames (no extension) from the
 * vault — deliberately the vault filename rather than the slug so that a
 * rename in either direction fails loudly instead of silently unpublishing.
 */
const PUBLISHED: string[] = [
  // ── Wave E1 (2026-07) — highest urgent intent; the fight hub anchors the mesh.
  "Approved-claim-01_how-to-fight-a-medical-bill",
  "Approved-claim-02_how-to-negotiate-a-medical-bill",
  "Approved-claim-03_how-to-know-if-you-were-overcharged",
  "Approved-claim-04_how-to-get-an-itemized-hospital-bill",
  "Approved-benefits-01_what-does-my-health-insurance-actually-cover",
  "Approved-benefits-02_how-to-read-an-eob",
];

/**
 * Canonical host for the in-article CTA. The articles were authored against
 * the apex (`candidclaim.com`), which costs a redirect hop and risks dropping
 * query params if the apex rule is ever misconfigured — the Vercel apex flip
 * is still open. Every CTA is rewritten to the www canonical here.
 */
const CANONICAL_ORIGIN = "https://www.candidclaim.com";

interface SourceArticle {
  basename: string;
  frontmatter: Record<string, string>;
  body: string;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

/**
 * Vault frontmatter is hand-maintained YAML with one list field
 * (`secondary_queries`). We read the scalars and drop list entries — the
 * published frontmatter is a narrower, flatter shape by design.
 */
function readVaultArticle(dir: string, basename: string): SourceArticle {
  const raw = readFileSync(join(dir, `${basename}.md`), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) fail(`${basename}: missing frontmatter`);

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim() || /^\s+-\s/.test(line)) continue; // list items → dropped
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) continue; // list headers such as `secondary_queries:`
    let value = pair[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (value) frontmatter[pair[1]] = value;
  }

  return { basename, frontmatter, body: raw.slice(match[0].length) };
}

/**
 * Read an already-published article back, split into the parts that decide
 * whether it changed (`stableHeader` + `body`) and the dates carried forward.
 * Returns null when this article has never been published.
 */
function readPublished(
  file: string,
): { stableHeader: string; body: string; published: string; lastUpdated: string } | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(raw);
  if (!match) return null; // unreadable → treat as new and rewrite cleanly

  const lines = match[1].split("\n");
  const dateLine = lines.find((l) => l.startsWith("last_updated:"));
  const publishedLine = lines.find((l) => l.startsWith("published:"));
  if (!dateLine || !publishedLine) return null;

  return {
    stableHeader: lines.filter((l) => !l.startsWith("last_updated:")).join("\n"),
    body: match[2].trim(),
    published: JSON.parse(publishedLine.slice("published:".length).trim()) as string,
    lastUpdated: JSON.parse(dateLine.slice("last_updated:".length).trim()) as string,
  };
}

/** `Approved-claim-04_…` → 4. Preserves editorial sequence on the hub. */
function orderOf(basename: string): number {
  const match = /^Approved-[a-z]+-(\d+)_/.exec(basename);
  if (!match) fail(`${basename}: cannot derive order from filename`);
  return Number(match[1]);
}

function main(): void {
  const vaultDir = arg("vault") ?? VAULT_DEFAULT;
  const publishDate = arg("date") ?? new Date().toISOString().slice(0, 10);
  const checkOnly = process.argv.includes("--check");

  if (!existsSync(vaultDir)) fail(`vault directory not found: ${vaultDir}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) fail(`--date must be YYYY-MM-DD (got "${publishDate}")`);

  // The FULL portfolio, not just the published set: cross-links resolve
  // against every article that exists so a link to an unpublished piece is a
  // known-and-deferred case rather than an unresolvable one.
  const allBasenames = readdirSync(vaultDir)
    .filter((f) => f.startsWith("Approved-") && f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));

  const slugOf = new Map<string, string>();
  for (const basename of allBasenames) {
    const { frontmatter } = readVaultArticle(vaultDir, basename);
    const slug = frontmatter.slug;
    if (!slug) fail(`${basename}: frontmatter has no slug`);
    slugOf.set(basename, slug);
  }

  const publishedSlugs = new Set(
    PUBLISHED.map((basename) => {
      const slug = slugOf.get(basename);
      if (!slug) fail(`PUBLISHED lists "${basename}", which is not in ${vaultDir}`);
      return slug;
    }),
  );

  console.log(`Portfolio: ${allBasenames.length} articles · publishing ${PUBLISHED.length} · date ${publishDate}`);

  const written: string[] = [];
  let totalLinked = 0;
  let totalDeferred = 0;

  for (const basename of PUBLISHED) {
    const { frontmatter, body } = readVaultArticle(vaultDir, basename);

    if (frontmatter.status !== "APPROVED") {
      fail(`${basename}: status is "${frontmatter.status}", expected APPROVED — nothing unapproved publishes`);
    }
    const slug = frontmatter.slug;
    const cluster = frontmatter.cluster;
    if (!frontmatter.title || !frontmatter.description || !cluster || !frontmatter.target_query) {
      fail(`${basename}: frontmatter missing one of title/description/cluster/target_query`);
    }

    let out = body;

    // 1. Strip the vault-only STATUS banner (and the blank line after it).
    const banner = /^> \*\*STATUS:[^\n]*\n\n?/m;
    if (!banner.test(out)) fail(`${basename}: expected a "> **STATUS:" banner to strip`);
    out = out.replace(banner, "");

    // 2. Strip the H1. The template renders it from frontmatter instead, so
    //    the page's <h1> and <title> are guaranteed to come from one string.
    const h1 = /^# .+\n\n?/m;
    if (!h1.test(out)) fail(`${basename}: expected a single H1 to strip`);
    out = out.replace(h1, "");
    if (/^# /m.test(out)) fail(`${basename}: more than one H1 in the body`);

    // 3. Wiki-links → hrefs. Two authored forms: `[[base|anchor]]` and, inside
    //    GFM table cells, the pipe-escaped `[[base\|anchor]]`.
    let linked = 0;
    let deferred = 0;
    const resolve = (target: string, anchor: string): string => {
      const targetSlug = slugOf.get(target);
      if (!targetSlug) {
        fail(`${basename}: wiki-link to unknown article "${target}" (renamed or typo)`);
      }
      if (publishedSlugs.has(targetSlug)) {
        linked++;
        return `[${anchor}](/learn/${targetSlug})`;
      }
      // Not published yet: keep the sentence intact, drop the link rather than
      // ship a 404. A later wave's re-run promotes it to a real link.
      deferred++;
      return anchor;
    };

    out = out.replace(/\[\[([^\]|]+?)\\?\|([^\]]+?)\]\]/g, (_m, target: string, anchor: string) =>
      resolve(target.trim(), anchor),
    );
    out = out.replace(/\[\[([^\]]+?)\]\]/g, (_m, target: string) => {
      const clean = target.trim();
      return resolve(clean, slugOf.get(clean) ?? clean);
    });
    if (/\[\[/.test(out)) fail(`${basename}: unconverted wiki-link syntax remains`);

    // 4. CTA links → www canonical, campaign-only UTM. `utm_source`/`utm_medium`
    //    stay reserved for EXTERNAL acquisition so our own pages never appear
    //    as a channel in /admin/growth; `utm_campaign` still identifies the
    //    converting article for direct arrivals (first-touch wins, so it is
    //    only ever recorded when nothing else claimed the visit).
    const ctaPattern = /https?:\/\/(?:www\.)?candidclaim\.com\/?\?[^\s)]*utm_[^\s)]*/g;
    const ctaCount = (out.match(ctaPattern) ?? []).length;
    if (ctaCount === 0) fail(`${basename}: no Candid CTA link found`);
    out = out.replace(ctaPattern, `${CANONICAL_ORIGIN}/?utm_campaign=${slug}`);

    // 5. Frontmatter for the published artifact: flat, JSON-encoded scalars.
    //    Dates are load-bearing for freshness signals, so they are preserved
    //    rather than restamped: `published` is set once and never moves, and
    //    `last_updated` only advances when the generated article actually
    //    differs from what is already published. Without this, re-running for
    //    a later wave would silently claim every earlier article was revised
    //    today — inflated freshness that search and AI engines do read.
    const existing = readPublished(join(CONTENT_DIR, `${slug}.md`));
    const stable = {
      slug,
      title: frontmatter.title,
      description: frontmatter.description,
      cluster,
      order: String(orderOf(basename)),
      target_query: frontmatter.target_query,
      published: existing?.published ?? publishDate,
    };
    const stableHeader = Object.entries(stable)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    const publishedBody = out.trim();
    const unchanged =
      existing !== null && existing.stableHeader === stableHeader && existing.body === publishedBody;
    const lastUpdated = unchanged ? existing.lastUpdated : publishDate;

    const file = join(CONTENT_DIR, `${slug}.md`);
    const contents = `---\n${stableHeader}\nlast_updated: ${JSON.stringify(lastUpdated)}\n---\n\n${publishedBody}\n`;

    if (checkOnly) {
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (current !== contents) fail(`${slug}.md is out of sync with the vault — re-run without --check`);
    } else {
      mkdirSync(CONTENT_DIR, { recursive: true });
      writeFileSync(file, contents, "utf8");
    }

    written.push(`${slug}.md`);
    totalLinked += linked;
    totalDeferred += deferred;
    console.log(`  ${slug}.md — ${linked} link(s) live, ${deferred} deferred (unpublished), ${ctaCount} CTA`);
  }

  // Anything in content/learn that is no longer in PUBLISHED was unpublished:
  // remove it so the directory listing stays an honest published set.
  if (!checkOnly && existsSync(CONTENT_DIR)) {
    for (const file of readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"))) {
      if (!written.includes(file)) {
        rmSync(join(CONTENT_DIR, file));
        console.log(`  removed ${file} (no longer in PUBLISHED)`);
      }
    }
  }

  console.log(
    `\n${checkOnly ? "In sync" : "Wrote"}: ${written.length} article(s) · ${totalLinked} internal link(s) live · ${totalDeferred} deferred until a later wave\n`,
  );
}

main();
