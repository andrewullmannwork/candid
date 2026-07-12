import type { MetadataRoute } from "next";

// Health-data + authenticated routes stay out of every crawler's index (PHI
// posture). This list is applied to the wildcard group AND to each named
// AI/search bot below: per the robots spec a bot obeys only the MOST specific
// user-agent group that matches it and ignores "*", so the disallow list must be
// repeated in each named group — it is not inherited.
const CHD_DISALLOW = [
  "/admin", // no trailing slash → blocks /admin index AND /admin/*
  "/api",
  "/dashboard",
  "/profile",
  "/settings",
  "/upload",
  "/audit",
  "/disputes",
  "/billing",
  "/plan",
  "/compare",
  "/care",
  "/claim",
  "/case",
  "/small-claims",
  "/hsa-marketplace",
  "/support",
];

// Explicitly welcome the AI-answer + search crawlers on public content (GEO:
// ChatGPT via GPTBot/Bing, Claude, Perplexity, Gemini, Common Crawl). Naming
// them is intent signalling; each still inherits CHD_DISALLOW so they never
// reach health-data routes.
const AI_AND_SEARCH_BOTS = [
  "GPTBot", // OpenAI — training/crawl
  "OAI-SearchBot", // OpenAI — search index
  "ChatGPT-User", // OpenAI — user-triggered fetch
  "ClaudeBot", // Anthropic — crawl
  "anthropic-ai", // Anthropic — legacy token
  "PerplexityBot", // Perplexity — index
  "Perplexity-User", // Perplexity — user-triggered fetch
  "Google-Extended", // Google — Gemini / Vertex training opt-in
  "Applebot-Extended", // Apple — AI training opt-in
  "Bingbot", // Bing — search (feeds ChatGPT search)
  "Amazonbot", // Amazon — Alexa / Rufus answers
  "meta-externalagent", // Meta AI / Llama
  "CCBot", // Common Crawl — feeds many LLMs
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: CHD_DISALLOW },
      ...AI_AND_SEARCH_BOTS.map((userAgent) => ({
        userAgent,
        allow: "/",
        disallow: CHD_DISALLOW,
      })),
    ],
    sitemap: "https://www.candidclaim.com/sitemap.xml",
    host: "https://www.candidclaim.com",
  };
}
