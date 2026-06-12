/**
 * QStash message queue — guaranteed delivery for document chunk processing.
 *
 * Instead of fire-and-forget fetch (which dies when the Vercel function returns),
 * we publish messages to QStash. QStash calls our endpoint with automatic retries
 * (3x by default), so processing completes even if the user closes their browser.
 *
 * Free tier: 500 messages/day.
 */

import { Client } from "@upstash/qstash";

let _client: Client | null = null;

function getClient(): Client | null {
  if (_client) return _client;
  const token = process.env.QSTASH_TOKEN;
  if (!token) return null;
  // QSTASH_URL pins the SDK to the project's home region (e.g.
  // https://qstash-us-east-1.upstash.io). Without it, the SDK has been
  // hitting eu-central-1 in PROD and getting 404 "user not found in this
  // region", silently falling through to the direct-fetch fallback below.
  // Set this env var on Vercel Production + Preview tiers.
  const baseUrl = process.env.QSTASH_URL;
  _client = baseUrl ? new Client({ token, baseUrl }) : new Client({ token });
  return _client;
}

/**
 * Enqueue the next processing chunk for a document.
 * Falls back to direct fetch if QStash is not configured (dev mode).
 */
export async function enqueueChunk(documentId: string, baseUrl: string): Promise<boolean> {
  const client = getClient();
  const targetUrl = `${baseUrl}/api/documents/process-chunk`;

  if (client) {
    try {
      await client.publishJSON({
        url: targetUrl,
        body: { documentId },
        retries: 3,
        // Delay 1s to avoid overlapping with in-flight requests
        delay: 1,
        // S195 hardening: wait as long as the receiving function may legally
        // run (process-chunk maxDuration=800). Without this, QStash gave up on
        // long invocations and RE-DELIVERED while they were still alive —
        // duplicate claimants re-ran finished work and clobbered each other's
        // checkpoint state (observed live on the EOC-RESUME validation parse).
        timeout: "800s",
      });
      return true;
    } catch (err) {
      console.error("[qstash] Publish failed, falling back to direct fetch:", err);
    }
  }

  // Fallback: direct fetch (for local dev or if QStash is not configured).
  //
  // S101 fix — fire-and-forget intentionally. The Next.js dev server doesn't
  // terminate the moment a response is sent (unlike Vercel serverless), so the
  // background fetch completes successfully even though we don't await it.
  // Awaiting here previously caused the upload route to block for the entire
  // chunk parse (~50-90s for an 8-page SBC), which prevented the frontend from
  // ever showing the page-count loading screen. In PROD this code path isn't
  // hit (QStash publish is fast); this is dev-only.
  try {
    fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId }),
    }).catch((err) => {
      console.error("[qstash] Direct fetch fallback rejected:", err);
    });
    return true;
  } catch (err) {
    console.error("[qstash] Direct fetch fallback synchronous error:", err);
    return false;
  }
}
