import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { AuthProvider } from "@/lib/auth/auth-context";
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
    default: "Candid — Stop Overpaying for Healthcare",
    template: "%s | Candid",
  },
  description:
    "Audit your medical bills, discover unused insurance benefits, and generate dispute letters. Free bill audit — no credit card required.",
  metadataBase: new URL("https://candidclaim.com"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Candid — Stop Overpaying for Healthcare",
    description:
      "3 in 4 medical bills contain errors. Candid finds overcharges, surfaces benefits you're not using, and drafts dispute letters — for free.",
    url: "https://candidclaim.com",
    siteName: "Candid",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Candid — Stop Overpaying for Healthcare",
    description:
      "3 in 4 medical bills contain errors. Candid finds overcharges, surfaces benefits you're not using, and drafts dispute letters — for free.",
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
        <AuthProvider>{children}</AuthProvider>
        <Analytics />
      </body>
    </html>
  );
}
