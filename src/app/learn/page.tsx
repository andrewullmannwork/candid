import type { Metadata } from "next";
import Link from "next/link";
import { CLUSTERS, listArticles, type Cluster } from "@/lib/learn/articles";
import { LearnFooter, LearnHeader } from "@/components/learn/LearnChrome";

// The hub is the internal-linking root for the whole editorial portfolio and
// the entry point llms.txt already advertises. Static, like the articles.
const ORIGIN = "https://www.candidclaim.com";

/** Reader-facing name for each product pillar. */
const CLUSTER_LABEL: Record<Cluster, string> = {
  claim: "Fight a bill",
  benefits: "Understand your coverage",
  compare: "Choose the right plan",
};

/**
 * The on-page lede, Andrew-approved 2026-07-27.
 *
 * The meta/OG description is its FIRST SENTENCE rather than the whole thing:
 * search engines truncate descriptions around 160 characters, and the full
 * lede runs past 240 — it would be cut mid-clause. Using the opening sentence
 * verbatim keeps the snippet within budget without rewording approved copy.
 */
// S324 (Andrew ruling, 2026-08-26): debt-reduction framing ("negotiate your
// total medical cost down", "eliminate surprise costs") removed from the hub
// lede + indexed meta — the accuracy-lane surfaces are marketed on accuracy
// and coverage, never savings (DFPI primary-purpose discipline).
const LEDE =
  "Step-by-step guides to understand your medical bills, dispute incorrect charges, and find out what you actually owe. Plus, information on how to deal with collections, understand surprise-billing protections, and how to get the most out of your benefits.";

const META_DESCRIPTION =
  "Step-by-step guides to understand your medical bills, dispute incorrect charges, and find out what you actually owe.";

export const metadata: Metadata = {
  title: "Guides",
  description: META_DESCRIPTION,
  alternates: { canonical: "/learn" },
  openGraph: {
    type: "website",
    title: "Candid Guides",
    description: META_DESCRIPTION,
    url: `${ORIGIN}/learn`,
    siteName: "Candid Claim",
    locale: "en_US",
  },
};

export default function LearnHubPage() {
  const articles = listArticles();
  const clusters = CLUSTERS.map((cluster) => ({
    cluster,
    label: CLUSTER_LABEL[cluster],
    items: articles.filter((article) => article.cluster === cluster),
  })).filter((group) => group.items.length > 0);

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: "Candid Guides",
        description: metadata.description,
        url: `${ORIGIN}/learn`,
        inLanguage: "en-US",
        isPartOf: { "@type": "WebSite", name: "Candid Claim", url: ORIGIN },
        mainEntity: {
          "@type": "ItemList",
          itemListElement: articles.map((article, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: article.title,
            url: `${ORIGIN}/learn/${article.slug}`,
          })),
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Candid", item: ORIGIN },
          { "@type": "ListItem", position: 2, name: "Guides", item: `${ORIGIN}/learn` },
        ],
      },
    ],
  };

  return (
    <div className="learn-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LearnHeader />

      <main className="learn-main">
        <h1 className="learn-title">Guides</h1>
        <p className="learn-lede">{LEDE}</p>
        {/* Newsletter link — Andrew-approved copy (2026-07-31). A plain <a>,
            deliberately NEVER Substack's embed widget: the embed injects
            third-party script and the marketing surface is verified
            zero-third-party-scripts. */}
        <p className="learn-chronicle">
          <strong>The Candid Chronicle</strong> - a weekly brief on medical bills and health
          insurance, from the author of these guides.{" "}
          <a
            href="https://thecandidchronicle.substack.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="learn-chronicle-link"
          >
            Subscribe free →
          </a>
        </p>

        {clusters.map((group) => (
          <section key={group.cluster} className="learn-cluster">
            <h2 className="learn-cluster-title">{group.label}</h2>
            <ul className="learn-list">
              {group.items.map((article) => (
                <li key={article.slug}>
                  <Link href={`/learn/${article.slug}`} className="learn-card">
                    <span className="learn-card-title">{article.title}</span>
                    <span className="learn-card-desc">{article.description}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>

      <LearnFooter />
    </div>
  );
}
