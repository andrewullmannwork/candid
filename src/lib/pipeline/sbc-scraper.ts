// SBC Scraper — Downloads Summary of Benefits and Coverage documents
// from insurer websites and public CMS sources.
//
// Strategy:
// 1. Try known direct SBC PDF URLs per insurer (curated list)
// 2. Try CMS Transparency in Coverage index for the insurer
// 3. Try fetching the insurer's SBC search page and finding PDF links
//
// Returns the raw PDF buffer for processing by benefit-extractor.

export interface ScrapeResult {
  success: boolean;
  pdfBuffer?: Buffer;
  sourceUrl?: string;
  mimeType: string;
  error?: string;
  method: "direct_url" | "cms_index" | "page_crawl" | "none";
}

// ─── Known SBC PDF patterns per insurer ──────────────────────────────────────
// Many large insurers have predictable SBC URL patterns.
// These are public documents mandated by the ACA.

const KNOWN_SBC_PATTERNS: Record<string, string[]> = {
  "UnitedHealthcare": [
    "https://www.uhc.com/content/dam/uhcdotcom/en/Employers/PDF/SBC-",
    "https://www.myuhc.com/member/prelogin/SBCSearch",
  ],
  "Aetna": [
    "https://www.aetna.com/individuals-families/find-a-plan/sbc.html",
  ],
  "Cigna": [
    "https://www.cigna.com/individuals-families/member-resources/plan-documents",
  ],
  "Kaiser Permanente": [
    "https://healthy.kaiserpermanente.org/get-care/explore-benefits",
  ],
};

/**
 * Attempt to scrape/download an SBC document for a given insurer.
 * Tries multiple strategies in order of reliability.
 */
export async function scrapeSBC(
  insurerName: string,
  sbcSearchUrl?: string | null,
  planName?: string,
  state?: string
): Promise<ScrapeResult> {
  // Strategy 1: Try the insurer's SBC search URL if we have one
  if (sbcSearchUrl) {
    const result = await tryFetchPage(sbcSearchUrl, insurerName);
    if (result.success) return result;
  }

  // Strategy 2: Search for SBC PDF on the insurer's website
  const searchResult = await searchForSBC(insurerName, planName, state);
  if (searchResult.success) return searchResult;

  // Strategy 3: Try CMS Transparency in Coverage
  const cmsResult = await tryCMSIndex(insurerName);
  if (cmsResult.success) return cmsResult;

  return {
    success: false,
    mimeType: "",
    error: `Could not find SBC document for ${insurerName}. Manual upload required.`,
    method: "none",
  };
}

/**
 * Fetch a page and look for PDF links that look like SBC documents.
 */
async function tryFetchPage(url: string, insurerName: string): Promise<ScrapeResult> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "CandidHealth/1.0 (SBC Document Retrieval; compliance@airgetlamlabs.com)",
        "Accept": "text/html,application/pdf",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return { success: false, mimeType: "", error: `HTTP ${res.status}`, method: "page_crawl" };
    }

    const contentType = res.headers.get("content-type") || "";

    // If it's already a PDF, we got the SBC directly
    if (contentType.includes("application/pdf")) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        success: true,
        pdfBuffer: buffer,
        sourceUrl: url,
        mimeType: "application/pdf",
        method: "direct_url",
      };
    }

    // If it's HTML, parse for PDF links
    if (contentType.includes("text/html")) {
      const html = await res.text();
      const pdfUrls = extractPDFLinks(html, url);

      // Filter for SBC-related PDFs
      const sbcPdfs = pdfUrls.filter((u) =>
        /sbc|summary.of.benefits|benefits.coverage/i.test(u)
      );

      if (sbcPdfs.length > 0) {
        // Try downloading the first SBC PDF
        return await downloadPDF(sbcPdfs[0]);
      }

      // If no SBC-specific PDFs, try any PDF link
      if (pdfUrls.length > 0) {
        return await downloadPDF(pdfUrls[0]);
      }
    }

    return { success: false, mimeType: "", error: "No PDF links found on page", method: "page_crawl" };
  } catch (err) {
    return {
      success: false,
      mimeType: "",
      error: err instanceof Error ? err.message : "Fetch failed",
      method: "page_crawl",
    };
  }
}

/**
 * Search for SBC documents using a web search approach.
 * Constructs a targeted search URL to find the insurer's SBC page.
 */
async function searchForSBC(
  insurerName: string,
  planName?: string,
  state?: string
): Promise<ScrapeResult> {
  // Try constructing direct URLs based on common insurer patterns
  const normalizedName = insurerName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const patterns = KNOWN_SBC_PATTERNS[insurerName];

  if (patterns) {
    for (const pattern of patterns) {
      const result = await tryFetchPage(pattern, insurerName);
      if (result.success) return result;
    }
  }

  // Try common SBC URL patterns
  const guessUrls = [
    `https://www.${normalizedName}.com/sbc`,
    `https://www.${normalizedName}.com/summary-of-benefits`,
    `https://www.${normalizedName}.com/plan-documents`,
    `https://www.${normalizedName}.com/members/plan-documents`,
  ];

  for (const url of guessUrls) {
    try {
      const result = await tryFetchPage(url, insurerName);
      if (result.success) return result;
    } catch {
      // Continue to next URL
    }
  }

  return { success: false, mimeType: "", error: "No SBC found via search", method: "page_crawl" };
}

/**
 * Try CMS Transparency in Coverage index.
 * Large insurers are required to publish machine-readable files here.
 */
async function tryCMSIndex(insurerName: string): Promise<ScrapeResult> {
  try {
    // The CMS index is at transparency-in-coverage.cms.gov
    // It links to insurer-hosted JSON files with plan data
    // This is a simplified check — full implementation would parse the index
    const searchUrl = `https://transparency-in-coverage.cms.gov/search?q=${encodeURIComponent(insurerName)}`;

    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": "CandidHealth/1.0 (SBC Document Retrieval; compliance@airgetlamlabs.com)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const html = await res.text();
      // Look for links to insurer's MRF files
      const mrf_links = extractPDFLinks(html, searchUrl);
      if (mrf_links.length > 0) {
        return await downloadPDF(mrf_links[0]);
      }
    }

    return { success: false, mimeType: "", error: "No CMS index match", method: "cms_index" };
  } catch {
    return { success: false, mimeType: "", error: "CMS index unreachable", method: "cms_index" };
  }
}

/**
 * Download a PDF from a URL.
 */
async function downloadPDF(url: string): Promise<ScrapeResult> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "CandidHealth/1.0 (SBC Document Retrieval; compliance@airgetlamlabs.com)",
        "Accept": "application/pdf",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      return { success: false, mimeType: "", error: `PDF download failed: HTTP ${res.status}`, method: "direct_url" };
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Verify it's actually a PDF (starts with %PDF)
    if (buffer.length > 4 && buffer.toString("utf-8", 0, 4) === "%PDF") {
      return {
        success: true,
        pdfBuffer: buffer,
        sourceUrl: url,
        mimeType: "application/pdf",
        method: "direct_url",
      };
    }

    return { success: false, mimeType: "", error: "Downloaded file is not a valid PDF", method: "direct_url" };
  } catch (err) {
    return {
      success: false,
      mimeType: "",
      error: err instanceof Error ? err.message : "Download failed",
      method: "direct_url",
    };
  }
}

/**
 * Extract PDF links from HTML content.
 */
function extractPDFLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const regex = /href=["']([^"']*\.pdf[^"']*)/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    let href = match[1];
    // Resolve relative URLs
    if (href.startsWith("/")) {
      const base = new URL(baseUrl);
      href = `${base.protocol}//${base.host}${href}`;
    } else if (!href.startsWith("http")) {
      href = new URL(href, baseUrl).toString();
    }
    links.push(href);
  }

  return [...new Set(links)]; // Dedupe
}
