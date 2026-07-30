import type { Metadata } from "next";
import Link from "next/link";
import { listArticles } from "@/lib/learn/articles";
import { AUTHOR } from "@/lib/learn/author";
import { LearnFooter, LearnHeader } from "@/components/learn/LearnChrome";

// The canonical home of the Person entity every guide's `author` points at.
// A byline that links nowhere is a weak signal; this is the page that makes it
// real for both a reader and a crawler.
const ORIGIN = "https://www.candidclaim.com";

export const metadata: Metadata = {
  title: `About ${AUTHOR.name}`,
  description: `${AUTHOR.name} is the founder of Candid and the author of its guides to checking, disputing, and negotiating medical bills.`,
  alternates: { canonical: AUTHOR.path },
  openGraph: {
    type: "profile",
    title: `About ${AUTHOR.name}`,
    description: `${AUTHOR.name} is the founder of Candid and the author of its guides to medical bills and health insurance.`,
    url: `${ORIGIN}${AUTHOR.path}`,
    siteName: "Candid Claim",
    locale: "en_US",
  },
};

export default function AboutPage() {
  const articles = listArticles();

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ProfilePage",
        url: `${ORIGIN}${AUTHOR.path}`,
        inLanguage: "en-US",
        mainEntity: { "@id": `${ORIGIN}${AUTHOR.path}#person` },
      },
      {
        "@type": "Person",
        "@id": `${ORIGIN}${AUTHOR.path}#person`,
        name: AUTHOR.name,
        url: `${ORIGIN}${AUTHOR.path}`,
        jobTitle: AUTHOR.role,
        description: AUTHOR.bio,
        worksFor: {
          "@type": "Organization",
          name: "Candid Claim",
          legalName: "Airgetlam Labs LLC",
          url: ORIGIN,
        },
        knowsAbout: [
          "Medical billing errors",
          "Medical bill disputes",
          "Explanation of benefits (EOB) review",
          "Health insurance benefits",
          "Surprise billing and the No Surprises Act",
        ],
        ...(AUTHOR.sameAs.length > 0 ? { sameAs: AUTHOR.sameAs } : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Candid", item: ORIGIN },
          { "@type": "ListItem", position: 2, name: `About ${AUTHOR.name}`, item: `${ORIGIN}${AUTHOR.path}` },
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
        <h1 className="learn-title">{AUTHOR.name}</h1>
        <p className="learn-meta">{AUTHOR.role}</p>

        <div className="learn-prose">
          <p>{AUTHOR.bio}</p>
          <p>
            Candid is operated by Airgetlam Labs LLC. It is not a healthcare provider, law firm,
            or insurance company, and nothing on this site is legal, medical, or financial advice.
            The guides describe process: what a document is, what it should say, and what to do
            when it does not.
          </p>
        </div>

        <section className="learn-cluster">
          <h2 className="learn-cluster-title">Guides by {AUTHOR.name}</h2>
          <ul className="learn-list">
            {articles.map((article) => (
              <li key={article.slug}>
                <Link href={`/learn/${article.slug}`} className="learn-card">
                  <span className="learn-card-title">{article.title}</span>
                  <span className="learn-card-desc">{article.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <LearnFooter />
    </div>
  );
}
