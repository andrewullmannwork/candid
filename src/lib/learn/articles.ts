/**
 * /learn article loader — reads the published editorial portfolio from
 * `content/learn/*.md` and exposes it to the route handlers.
 *
 * The markdown in `content/learn` is GENERATED, never hand-edited: the vault
 * copies under `01_Inbox/Candid_GTM/articles/` are the editorial source of
 * truth, and `scripts/learn/sync-articles.ts` performs the publish transform
 * (banner strip, wiki-link → href, CTA rewrite). The directory listing IS the
 * published set — a wave ships by adding its files here, so there is no flag
 * and no filtering (marketing surface, per GTM-05).
 *
 * Frontmatter is written by that script in a deliberately narrow shape: flat
 * `key: <json-encoded-scalar>` pairs only. No lists, no nesting, no YAML
 * ambiguity — which is why the ~20-line parser below is sufficient and no
 * dependency is needed. Anything malformed throws at build time (these pages
 * are statically generated, so a bad article fails the deploy rather than
 * shipping a broken page).
 *
 * Server-only by construction (node:fs). Reads happen during `next build`;
 * nothing touches the filesystem at request time.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const CONTENT_DIR = join(process.cwd(), "content/learn");

/** The three product pillars. An article's cluster is its hub grouping. */
export const CLUSTERS = ["claim", "benefits", "compare"] as const;
export type Cluster = (typeof CLUSTERS)[number];

const FrontmatterSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
  title: z.string().min(1),
  description: z.string().min(1),
  cluster: z.enum(CLUSTERS),
  /** Editorial sequence within the cluster, from the source filename. */
  order: z.coerce.number().int().nonnegative(),
  target_query: z.string().min(1),
  /** First publish date — set once, never moves. */
  published: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "published must be YYYY-MM-DD"),
  /** Advances only when the article's content actually changed. */
  last_updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "last_updated must be YYYY-MM-DD"),
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface FaqEntry {
  question: string;
  /** Plain text — markdown stripped, for the FAQPage JSON-LD. */
  answer: string;
}

export interface Article extends Frontmatter {
  /** Markdown body, H1 and status banner already removed by the sync script. */
  body: string;
  faq: FaqEntry[];
}

/**
 * Split `---\n…\n---\n` frontmatter from the body. Values are JSON-encoded by
 * the sync script when they contain anything interesting (every title has a
 * colon in it, several have quotes), so a bare `split(":")` would corrupt them.
 */
function parseFrontmatter(raw: string, file: string): { data: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!match) throw new Error(`[learn] ${file}: missing frontmatter block`);

  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`[learn] ${file}: unparseable frontmatter line: ${line}`);
    const [, key, rawValue] = pair;
    data[key] = rawValue.startsWith('"') ? (JSON.parse(rawValue) as string) : rawValue.trim();
  }

  return { data, body: raw.slice(match[0].length) };
}

/**
 * Reduce markdown to plain text for JSON-LD. Schema.org answer text is quoted
 * verbatim by search and AI engines, so it must not carry link or emphasis
 * syntax — and it must stay derived from the rendered copy rather than
 * duplicated in frontmatter, so the two can never drift.
 */
function toPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → anchor text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1") // italic
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/^\s*[-*]\s+/gm, "") // list bullets
    .replace(/^\s*>\s?/gm, "") // blockquote markers
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the `## FAQ` section into question/answer pairs for FAQPage JSON-LD.
 * The section runs to the next H2 or the closing `---` rule (every article
 * ends with a horizontal rule and the general-information disclaimer, which
 * must not be swallowed into the final answer).
 */
export function extractFaq(body: string): FaqEntry[] {
  const heading = /^## FAQ\s*$/m.exec(body);
  if (!heading) return [];

  const after = body.slice(heading.index + heading[0].length);
  const end = /^(?:## |---[ \t]*$)/m.exec(after);
  const section = end ? after.slice(0, end.index) : after;

  const questions = [...section.matchAll(/^### (.+)$/gm)];
  return questions.map((match, i) => {
    const start = (match.index ?? 0) + match[0].length;
    const stop = i + 1 < questions.length ? (questions[i + 1].index ?? section.length) : section.length;
    return {
      question: match[1].trim(),
      answer: toPlainText(section.slice(start, stop)),
    };
  });
}

let cache: Article[] | null = null;

function loadAll(): Article[] {
  if (cache) return cache;

  const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"));
  const articles = files.map((file) => {
    const { data, body } = parseFrontmatter(readFileSync(join(CONTENT_DIR, file), "utf8"), file);
    const parsed = FrontmatterSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`[learn] ${file}: invalid frontmatter — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    if (parsed.data.slug !== file.replace(/\.md$/, "")) {
      throw new Error(`[learn] ${file}: filename must match slug "${parsed.data.slug}"`);
    }
    return { ...parsed.data, body, faq: extractFaq(body) };
  });

  const slugs = new Set(articles.map((a) => a.slug));
  if (slugs.size !== articles.length) throw new Error("[learn] duplicate slug in content/learn");

  cache = articles.sort(
    (a, b) => CLUSTERS.indexOf(a.cluster) - CLUSTERS.indexOf(b.cluster) || a.order - b.order,
  );
  return cache;
}

/** Every published article, ordered by cluster then editorial sequence. */
export function listArticles(): Article[] {
  return loadAll();
}

/** One article by slug, or null when it is not part of a published wave. */
export function getArticle(slug: string): Article | null {
  return loadAll().find((a) => a.slug === slug) ?? null;
}
