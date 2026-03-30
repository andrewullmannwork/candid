import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { AuthProvider } from "@/lib/auth/auth-context";
import "./globals.css";

const GA_ID = "G-T2345232RV";

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
  metadataBase: new URL("https://candidclaim.com"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Candid Claim — Free Medical Bill Audit & Insurance Benefits Tool",
    description:
      "3 in 4 medical bills contain errors. Candid Claim finds overcharges, surfaces benefits you're not using, and drafts dispute letters — for free.",
    url: "https://candidclaim.com",
    siteName: "Candid Claim",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Candid Claim — Free Medical Bill Audit & Insurance Benefits Tool",
    description:
      "3 in 4 medical bills contain errors. Candid Claim finds overcharges, surfaces benefits you're not using, and drafts dispute letters — for free.",
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
  authors: [{ name: "Candid Claim", url: "https://candidclaim.com" }],
  creator: "Airgetlam Labs LLC",
  publisher: "Airgetlam Labs LLC",
  category: "Health",
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
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_ID}');
          `}
        </Script>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "Candid Claim",
              alternateName: "Candid",
              legalName: "Airgetlam Labs LLC",
              url: "https://candidclaim.com",
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
              offers: [
                {
                  "@type": "Offer",
                  name: "Free Medical Bill Audit",
                  price: "0",
                  priceCurrency: "USD",
                  description:
                    "Upload your medical bill or EOB and get a free audit to identify overcharges, duplicate charges, and billing errors.",
                },
                {
                  "@type": "Offer",
                  name: "Free Insurance Benefits Analysis",
                  price: "0",
                  priceCurrency: "USD",
                  description:
                    "Discover 35+ commonly covered insurance benefits you may not be using, personalized to your plan, state, and demographics.",
                },
              ],
            }),
          }}
        />
        <AuthProvider>{children}</AuthProvider>
        <Analytics />
      </body>
    </html>
  );
}
