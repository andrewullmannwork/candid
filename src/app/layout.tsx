import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/lib/auth/auth-context";
import { FirstTouchCapture } from "@/components/attribution/FirstTouchCapture";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    // Keyword-first: every keyword char sits inside Google's ~580px cutoff;
    // only the brand suffix can clip, and the WebSite JSON-LD below renders
    // "Candid Claim" as the SERP site name regardless.
    default: "Free Medical Bill Audit & Insurance Benefits Checker | Candid Claim",
    template: "%s | Candid Claim",
  },
  description:
    "Free medical bill audit in minutes. Candid finds overcharges, drafts dispute letters, and shows what your insurance covers. No credit card required.",
  metadataBase: new URL("https://www.candidclaim.com"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "You pay a lot for healthcare. Get the most out of it.",
    description:
      "Free bill audit and benefits analysis. We'll tell you if you've been overcharged and what your plan covers — in under five minutes.",
    url: "https://www.candidclaim.com",
    siteName: "Candid Claim",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "You pay a lot for healthcare. Get the most out of it.",
    description:
      "Free bill audit and benefits analysis. We'll tell you if you've been overcharged and what your plan covers — in under five minutes.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  other: {
    "theme-color": "#2563eb",
    "apple-mobile-web-app-title": "Candid Claim",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
  keywords: [
    // Group 1: "My bill looks wrong"
    "was I overcharged at the hospital",
    "check medical bill for errors",
    "how to dispute a medical bill",
    "medical bill too high what to do",
    "medical bill dispute letter",
    "hospital overcharge",
    "medical billing errors",
    "free medical bill review",
    "medical bill review tool",
    "how to read a medical bill",
    "unfair hospital charges",
    "double charged medical bill",
    "how to lower my medical bill",
    "medical billing advocate",
    "charged for services not received",
    "balance billing is it legal",
    "emergency room bill too high",
    "overcharged by doctor",
    "surprise medical bill help",
    // Group 2: "What does my insurance cover?"
    "what does my insurance cover",
    "insurance benefits not using",
    "hidden health insurance benefits",
    "does my insurance cover therapy",
    "does my insurance cover acupuncture",
    "does my insurance cover chiropractor",
    "does my insurance cover physical therapy",
    "what is my copay",
    "which doctors are in network",
    "in network vs out of network",
    "free preventive care",
    "how to get more out of health insurance",
    "HSA eligible expenses",
    "unused insurance benefits",
    "does my insurance cover mental health",
    "does insurance cover nutritionist",
    "does insurance cover fertility treatment",
    "how to find in network doctors",
    "what preventive care is free",
    "understanding my EOB",
    "am I using all my insurance benefits",
    // Group 3: fight / negotiate / itemize (aligned to the /learn guide targets)
    "how to fight a medical bill",
    "how to negotiate a medical bill",
    "how to get an itemized hospital bill",
    "why is my medical bill different from my EOB",
    "how to read an EOB",
    // Group 4: denials & appeals
    "insurance denied my claim what to do",
    "appeal denied health insurance claim",
    "how to appeal a health insurance denial",
    "insurance appeal letter template",
    "external review health insurance",
    "prior authorization denied what to do",
    // Group 5: collections & medical debt
    "medical bill in collections what to do",
    "debt validation letter for medical bill",
    "can I dispute a medical bill in collections",
    // Group 6: plan comparison & choice
    "how to compare health insurance plans",
    "compare health insurance plans side by side",
    "how to choose a health insurance plan",
    "HMO vs PPO which is better",
    "HDHP vs PPO which saves money",
    "health insurance comparison tool",
    "open enrollment how to choose a plan",
    // Group 7: cost-share mechanics (accumulator tracker)
    "deductible vs out of pocket maximum",
    "how to track my deductible",
    "does my insurance cover massage therapy",
  ],
  authors: [{ name: "Candid Claim", url: "https://www.candidclaim.com" }],
  creator: "Airgetlam Labs LLC",
  publisher: "Airgetlam Labs LLC",
  category: "Health",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* GA4 + Vercel Analytics removed (S199 — E2): they previously loaded on
            the root layout, firing on authenticated, health-data pages
            (/claim, /disputes, /plan, /upload) with no consent gate. Removed
            entirely to keep third-party analytics off consumer-health surfaces. */}
        {/* First-touch attribution (mig 203) is NOT analytics: first-party
            localStorage snapshot of UTM/referrer, no cookie, no tracker, no
            network call — persisted once at signup via /api/auth/sync. */}
        {/* Feed autodiscovery, rendered explicitly rather than via
            `metadata.alternates.types`: a page that sets its own `alternates`
            (every /learn page, /about, /terms…) REPLACES the layout's block
            wholesale, which silently dropped this tag from exactly the pages
            that need it. React hoists this into <head> site-wide. */}
        <link
          rel="alternate"
          type="application/atom+xml"
          title="Candid Guides"
          href="/learn/feed.xml"
        />
        <FirstTouchCapture />
        {/* Site-wide identity only. The product HowTo and the product FAQPage
            used to live here and therefore rode along on every page — which
            broke once /learn articles arrived, because each article carries
            its own FAQPage and two FAQPage entities on one URL is a conflict
            search engines resolve by trusting neither. Both moved to the
            landing page (src/app/page.tsx), which is what they describe. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Organization",
                  name: "Candid Claim",
                  alternateName: "Candid",
                  legalName: "Airgetlam Labs LLC",
                  url: "https://www.candidclaim.com",
                  logo: "https://www.candidclaim.com/logo.png",
                  description:
                    "Consumer medical bill audit and insurance benefits analysis tool. Upload bills to find overcharges, discover unused benefits, and draft dispute letters.",
                  foundingDate: "2026",
                  // Entity reconciliation: tells search and AI engines the
                  // LinkedIn page and this site are the same organization. The
                  // page name there is "Candid Claim" so it matches `name`
                  // above — a mismatch weakens the link. X/Twitter deferred.
                  sameAs: ["https://www.linkedin.com/company/candidclaim"],
                  knowsAbout: [
                    "Medical billing errors",
                    "Insurance benefits analysis",
                    "Healthcare overcharges",
                    "Medical bill dispute letters",
                    "EOB review",
                    "Health insurance plan comparison",
                    "Insurance denial appeals",
                    "Medical debt collections",
                  ],
                  // The three products as first-class Services — featureList
                  // below is a flat string array and cannot carry per-service
                  // descriptions; this can. No `url` on the Services: /claim,
                  // /plan, /compare are authed routes that bounce crawlers to
                  // sign-in, so pointing structured data at them is noise.
                  hasOfferCatalog: {
                    "@type": "OfferCatalog",
                    name: "The Candid Suite",
                    itemListElement: [
                      {
                        "@type": "Offer",
                        price: "0",
                        priceCurrency: "USD",
                        itemOffered: {
                          "@type": "Service",
                          name: "Candid Claim",
                          description:
                            "Free medical bill audit that checks every line, flags overcharges and billing errors, and drafts the dispute letter for you.",
                        },
                      },
                      {
                        "@type": "Offer",
                        price: "0",
                        priceCurrency: "USD",
                        itemOffered: {
                          "@type": "Service",
                          name: "Candid Plan",
                          description:
                            "Reads your insurance documents and shows what your plan covers — copays, visit limits, and benefits you're not using.",
                        },
                      },
                      {
                        "@type": "Offer",
                        price: "0",
                        priceCurrency: "USD",
                        itemOffered: {
                          "@type": "Service",
                          name: "Candid Compare",
                          description:
                            "Compares up to three health insurance plans side by side, with every number sourced from real plan documents.",
                        },
                      },
                    ],
                  },
                },
                {
                  // Site identity: Google draws the SERP "site name" line from
                  // WebSite structured data — this is what keeps "Candid Claim"
                  // visible even when the <title>'s brand suffix truncates.
                  "@type": "WebSite",
                  name: "Candid Claim",
                  alternateName: "Candid",
                  url: "https://www.candidclaim.com",
                },
                {
                  "@type": "WebApplication",
                  name: "Candid Claim",
                  url: "https://www.candidclaim.com",
                  applicationCategory: "HealthApplication",
                  operatingSystem: "Web",
                  description:
                    "Free medical bill audit and insurance benefits tool. Upload your bill to find overcharges and discover benefits you're not using.",
                  offers: {
                    "@type": "Offer",
                    price: "0",
                    priceCurrency: "USD",
                  },
                  // Query-shaped feature strings; every entry is a live PROD
                  // capability. ("In-network provider lookup" removed — no
                  // provider directory exists; never claim unshipped features.)
                  featureList: [
                    "Line-by-line medical bill audit",
                    "Overcharge, duplicate-charge, and billing-error detection",
                    "Medical bill dispute letter generator",
                    "Insurance benefits checker — see what your plan covers",
                    "Side-by-side health insurance plan comparison",
                    "Deductible and out-of-pocket maximum tracker",
                    "Health insurance appeal letter generator (denials and external review)",
                    "Debt validation letters for medical bills in collections",
                    "EOB-to-bill reconciliation",
                    "HSA/FSA eligibility flagging",
                  ],
                },
              ],
            }),
          }}
        />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
