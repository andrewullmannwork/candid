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
    default: "Candid Claim — Free Medical Bill Audit & Insurance Benefits Tool",
    template: "%s | Candid Claim",
  },
  description:
    "Upload your medical bill and get a free audit in seconds. Candid Claim finds overcharges, surfaces insurance benefits you're not using, and drafts dispute letters. No credit card required.",
  metadataBase: new URL("https://www.candidclaim.com"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Find medical bill errors. Discover benefits. Save money.",
    description:
      "See what your insurance is hiding. Upload your bill, select your plan, and we do the rest…",
    url: "https://www.candidclaim.com",
    siteName: "Candid Claim",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Find medical bill errors. Discover benefits. Save money.",
    description:
      "See what your insurance is hiding. Upload your bill, select your plan, and we do the rest…",
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
        <FirstTouchCapture />
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
                  sameAs: [],
                  knowsAbout: [
                    "Medical billing errors",
                    "Insurance benefits analysis",
                    "Healthcare overcharges",
                    "Medical bill dispute letters",
                    "EOB review",
                  ],
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
                  featureList: [
                    "Medical bill line-by-line audit",
                    "Overcharge and duplicate code detection",
                    "Dispute letter generation",
                    "Insurance benefits discovery",
                    "In-network provider lookup",
                    "HSA/FSA eligibility flagging",
                  ],
                },
                {
                  "@type": "HowTo",
                  name: "How to audit your medical bill with Candid Claim",
                  description:
                    "Three steps to find overcharges and discover unused insurance benefits.",
                  step: [
                    {
                      "@type": "HowToStep",
                      name: "Upload your documents",
                      text: "Snap a photo of your insurance card and upload your bills. We scan everything automatically to fill in your plan details.",
                    },
                    {
                      "@type": "HowToStep",
                      name: "Get your audit and benefit information",
                      text: "We compare every charge to benchmarks, flag errors, and surface covered benefits you're leaving on the table — in seconds.",
                    },
                    {
                      "@type": "HowToStep",
                      name: "Take action",
                      text: "Dispute letters, case files, benefit guides — everything you need to fight overcharges and get the most out of your plan. You stay in control.",
                    },
                  ],
                },
                {
                  "@type": "FAQPage",
                  mainEntity: [
                    {
                      "@type": "Question",
                      name: "How do I know if my medical bill has errors?",
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: "Upload your bill to Candid Claim. We compare every charge against benchmarks and flag overcharges, duplicate codes, unbundled procedures, and balance billing — each with a severity rating and dollar estimate.",
                      },
                    },
                    {
                      "@type": "Question",
                      name: "How do I dispute a medical bill?",
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: "Candid generates ready-to-send dispute letters based on the errors found in your audit. You review the letter, customize it if needed, and send it yourself. You stay in control.",
                      },
                    },
                    {
                      "@type": "Question",
                      name: "Does my insurance cover therapy, acupuncture, or chiropractic?",
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: "It depends on your plan. Candid reads your policy and shows you covered benefits in plain English — including therapy, acupuncture, chiropractic, preventive screenings, and more.",
                      },
                    },
                    {
                      "@type": "Question",
                      name: "Is Candid Claim free?",
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: "Yes. Candid Claim's bill audit and benefits discovery tools are free. No credit card required.",
                      },
                    },
                    {
                      "@type": "Question",
                      name: "Is my medical data safe with Candid?",
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: "Candid applies HIPAA-grade security safeguards by design (we are not a HIPAA-covered entity). Your documents are encrypted at rest and in transit. We never sell your personal health information. Every consent event is logged and you can revoke access anytime.",
                      },
                    },
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
