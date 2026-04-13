import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/profile/resolve-county?zip=27601
 *
 * Resolves a 5-digit zip code to county name + FIPS code using the CMS
 * Marketplace API counties endpoint. No auth required — public data.
 */
export async function GET(req: NextRequest) {
  const zip = req.nextUrl.searchParams.get("zip");

  if (!zip || !/^\d{5}$/.test(zip)) {
    return NextResponse.json(
      { error: "Provide a valid 5-digit zip code" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(
      `https://marketplace.api.healthcare.gov/api/v1/counties/by/zip/${zip}?apikey=d687412e7b53146b2631dc01974ad0a4`,
      { next: { revalidate: 86400 } } // cache 24h
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: "Zip code not found", counties: [] },
        { status: 200 }
      );
    }

    const data = await res.json();
    const counties: { fips: string; name: string; state: string }[] =
      (data.counties || []).map(
        (c: { fips: string; name: string; state: string }) => ({
          fips: c.fips,
          name: c.name,
          state: c.state,
        })
      );

    return NextResponse.json({ counties });
  } catch {
    return NextResponse.json(
      { error: "Failed to resolve county" },
      { status: 500 }
    );
  }
}
