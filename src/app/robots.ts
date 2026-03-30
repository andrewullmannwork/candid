import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin/", "/api/", "/dashboard", "/profile", "/settings", "/upload", "/audit", "/disputes", "/billing", "/plan", "/care", "/claim", "/case", "/support"],
      },
    ],
    sitemap: "https://candidclaim.com/sitemap.xml",
  };
}
