import type { Metadata } from "next";
import Link from "next/link";
import { listArticles } from "@/lib/learn/articles";
import { AUTHOR } from "@/lib/learn/author";
import { LearnFooter, LearnHeader } from "@/components/learn/LearnChrome";

// Candid-first about page (copy sheet v6.2, Andrew-approved 2026-07-30):
// mostly company information — what Candid is, how the guides are researched,
// who operates it — with a short professional author section so every guide's
// byline has a real Person to point at. No footer links here by decision; the
// byline and author box are the only entrances.
const ORIGIN = "https://www.candidclaim.com";

export const metadata: Metadata = {
  title: "About Candid",
  description:
    "Candid checks your medical bill line by line against your EOB and plan documents, flags errors and overcharges, and drafts the dispute letter. The audit is free.",
  alternates: { canonical: "/about" },
  openGraph: {
    type: "website",
    title: "About Candid",
    description:
      "Candid checks your medical bill line by line against your EOB and plan documents, flags errors and overcharges, and drafts the dispute letter. The audit is free.",
    url: `${ORIGIN}/about`,
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
        "@type": "AboutPage",
        url: `${ORIGIN}/about`,
        name: "About Candid",
        inLanguage: "en-US",
        mainEntity: { "@id": `${ORIGIN}/#organization` },
      },
      {
        // The Person every guide's `author` points at. sameAs stays empty
        // until a PERSONAL profile exists — the company LinkedIn belongs to
        // the Organization, not the Person (copy sheet §H).
        "@type": "Person",
        "@id": `${ORIGIN}/about#person`,
        name: AUTHOR.name,
        url: `${ORIGIN}${AUTHOR.path}`,
        jobTitle: AUTHOR.role,
        description: `${AUTHOR.name} is the founder of Candid. ${AUTHOR.bio}`,
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
          { "@type": "ListItem", position: 2, name: "About Candid", item: `${ORIGIN}/about` },
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
        <h1 className="learn-title">About Candid</h1>

        <div className="learn-prose">
          <p>
            Candid reads your medical bills and health insurance documents, then shows you
            what&apos;s wrong, what&apos;s covered, and what you actually owe.
          </p>
          <p>
            Upload a bill and Candid checks it line by line against your explanation of benefits,
            your plan&apos;s terms, and pricing benchmarks. It flags medical billing errors and
            overcharges, surfaces benefits your plan already covers, and drafts the dispute letter
            when something does not hold up. You review and send everything yourself.
          </p>
          <p>
            When it is time to pick coverage, Candid also compares health plans on what a year of
            your care would actually cost, not premiums alone.
          </p>

          <h2>How these guides are written</h2>
          <p>
            Every guide describes the same process the product automates, written from primary
            sources: plan documents and explanations of benefits themselves, federal rules such as
            the No Surprises Act, and published guidance from CMS, the Consumer Financial
            Protection Bureau, and state regulators. Where a guide relies on a specific figure,
            deadline, or legal protection, it links the source so you can check it yourself.
          </p>
          <p>
            Guides are updated when the underlying rules or our process change, and each one shows
            the date it was last updated. We do not publish outcome promises or statistics we
            cannot source.
          </p>

          <h2>Who operates Candid</h2>
          <p>Candid is operated by Airgetlam Labs LLC.</p>
          <p>
            Candid is not a healthcare provider, law firm, or insurance company. Nothing on this
            site is legal, medical, or financial advice. The guides describe process rather than
            advising on your particular situation: what a document is, what it should say, and what
            to do when it does not. Always consult a qualified professional.
          </p>

          <h2>Who writes the guides</h2>
          <p>
            The guides are written by {AUTHOR.name}, founder of Candid. {AUTHOR.bio}
          </p>
        </div>

        <section className="learn-cluster">
          <h2 className="learn-cluster-title">Guides to fighting medical bills</h2>
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

        <section className="learn-cluster">
          <h2 className="learn-cluster-title">See it on your own bill</h2>
          <p className="learn-lede" style={{ margin: 0 }}>
            The fastest way to understand Candid is to hand it a bill. The bill audit and benefits
            tools are free, and nothing is sent to anyone unless you send it.{" "}
            <Link href="/auth/signup" className="learn-chrome-cta" style={{ whiteSpace: "nowrap" }}>
              Sign up
            </Link>
          </p>
        </section>
      </main>

      <LearnFooter />
    </div>
  );
}
