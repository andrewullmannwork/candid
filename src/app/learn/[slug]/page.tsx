import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { getArticle, listArticles, type Article } from "@/lib/learn/articles";
import { LearnFooter, LearnHeader } from "@/components/learn/LearnChrome";
import { LearnVisit } from "@/components/learn/LearnVisit";

// Fully static: every published article is generated at build time and no
// unknown slug renders at runtime (dynamicParams false → 404). Nothing here
// touches the filesystem, the database, or a third-party script in production.
export const dynamicParams = false;

const ORIGIN = "https://www.candidclaim.com";

export function generateStaticParams() {
  return listArticles().map((article) => ({ slug: article.slug }));
}

// Wide comparison tables scroll inside themselves rather than widening the
// page; that is handled entirely in `.learn-prose table` CSS, so this renderer
// needs no per-element component overrides.

/**
 * Format a YYYY-MM-DD string without constructing a Date. `new Date("2026-07-27")`
 * parses as UTC midnight and renders as the 26th in every US timezone, so the
 * displayed date and the JSON-LD date would disagree by a day.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) return {};

  const url = `${ORIGIN}/learn/${article.slug}`;
  return {
    title: article.title,
    description: article.description,
    alternates: { canonical: `/learn/${article.slug}` },
    openGraph: {
      type: "article",
      title: article.title,
      description: article.description,
      url,
      siteName: "Candid Claim",
      locale: "en_US",
      publishedTime: article.published,
      modifiedTime: article.last_updated,
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.description,
    },
  };
}

/**
 * Article + FAQPage + BreadcrumbList for one guide.
 *
 * The FAQ entities are derived from the rendered `## FAQ` section rather than
 * duplicated in frontmatter, so the structured data can never drift from the
 * copy a reader sees. Note this is the ONLY FAQPage on the page: the site-wide
 * product FAQ lives on the landing page, because two FAQPage entities on one
 * URL is a conflict search engines resolve by trusting neither.
 */
function articleJsonLd(article: Article) {
  const url = `${ORIGIN}/learn/${article.slug}`;
  const publisher = {
    "@type": "Organization",
    name: "Candid Claim",
    legalName: "Airgetlam Labs LLC",
    url: ORIGIN,
    logo: { "@type": "ImageObject", url: `${ORIGIN}/logo.png` },
  };

  const graph: Record<string, unknown>[] = [
    {
      "@type": "Article",
      headline: article.title,
      description: article.description,
      datePublished: article.published,
      dateModified: article.last_updated,
      inLanguage: "en-US",
      author: publisher,
      publisher,
      mainEntityOfPage: { "@type": "WebPage", "@id": url },
      isAccessibleForFree: true,
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Candid", item: ORIGIN },
        { "@type": "ListItem", position: 2, name: "Guides", item: `${ORIGIN}/learn` },
        { "@type": "ListItem", position: 3, name: article.title, item: url },
      ],
    },
  ];

  if (article.faq.length > 0) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: article.faq.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: { "@type": "Answer", text: entry.answer },
      })),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

export default async function LearnArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) notFound();

  return (
    <div className="learn-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd(article)) }}
      />
      <LearnVisit slug={article.slug} />
      <LearnHeader />

      <main className="learn-main">
        <article>
          <nav className="learn-crumb" aria-label="Breadcrumb">
            <Link href="/learn">Guides</Link>
          </nav>
          <h1 className="learn-title">{article.title}</h1>
          <p className="learn-meta">
            Last updated{" "}
            <time dateTime={article.last_updated}>{formatDate(article.last_updated)}</time>
          </p>

          <div className="learn-prose">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>
              {article.body}
            </Markdown>
          </div>
        </article>
      </main>

      <LearnFooter />
    </div>
  );
}
