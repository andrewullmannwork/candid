import type { MetadataRoute } from "next";
import { listArticles } from "@/lib/learn/articles";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://www.candidclaim.com";

  // Editorial guides auto-include: publishing a wave (adding files to
  // content/learn) puts them in the sitemap with no edit here. `lastModified`
  // comes from each article's own last_updated, which only advances when the
  // content actually changed — so this never claims false freshness. Noon UTC
  // keeps the date from sliding a day backwards in western timezones.
  const guides: MetadataRoute.Sitemap = listArticles().map((article) => ({
    url: `${base}/learn/${article.slug}`,
    lastModified: new Date(`${article.last_updated}T12:00:00Z`),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [
    { url: base, lastModified: new Date(), changeFrequency: "weekly", priority: 1.0 },
    { url: `${base}/auth/signup`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/learn`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
    ...guides,
    // Author page — the Person entity every guide's byline points at.
    { url: `${base}/about`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/terms`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/privacy`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.3 },
    { url: `${base}/health-data`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.3 },
  ];
}
