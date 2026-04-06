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
  _client = new Client({ token });
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
      });
      return true;
    } catch (err) {
      console.error("[qstash] Publish failed, falling back to direct fetch:", err);
    }
  }

  // Fallback: direct fetch (for local dev or if QStash is not configured)
  try {
    await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId }),
    });
    return true;
  } catch (err) {
    console.error("[qstash] Direct fetch fallback also failed:", err);
    return false;
  }
}
