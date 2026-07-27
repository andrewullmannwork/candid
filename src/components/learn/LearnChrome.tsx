import Link from "next/link";

/**
 * Shared header + footer for the public /learn surface.
 *
 * These pages are marketing/SEO surfaces: no auth, no health data, no client
 * analytics. The footer reuses the landing page's existing legal copy verbatim
 * (parent-company attribution + the informational-only disclaimer) so there is
 * exactly one wording of it across the site.
 */

export function LearnHeader() {
  return (
    <header className="learn-chrome-head">
      <Link href="/" className="learn-wordmark" aria-label="Candid home">
        <span className="learn-wordmark-badge" aria-hidden="true">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        </span>
        Candid
      </Link>
      <nav className="learn-chrome-nav">
        <Link href="/learn">All guides</Link>
        {/* Verbatim reuse of the landing nav's CTA label. Deliberately not a
            new freeness claim ("free bill audit" etc.) — claim copy is
            curated and approved elsewhere, not minted here. */}
        <Link href="/auth/signup" className="learn-chrome-cta">
          Sign up
        </Link>
      </nav>
    </header>
  );
}

export function LearnFooter() {
  return (
    <footer className="learn-chrome-foot">
      <div className="learn-chrome-foot-top">
        <div className="learn-chrome-parent">An Airgetlam Labs LLC company.</div>
        <nav className="learn-chrome-foot-links">
          <Link href="/learn">Guides</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/health-data">Health Data Privacy</Link>
        </nav>
      </div>
      <p className="learn-chrome-disclaimer">
        Candid is not a healthcare provider, law firm, or insurance company. All outputs are
        informational and do not constitute legal, medical, or financial advice. Always consult a
        qualified professional. © {new Date().getFullYear()} Airgetlam Labs LLC. All rights
        reserved.
      </p>
    </footer>
  );
}
