/**
 * Slack request signature verification per
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Computes HMAC SHA256 of `v0:${timestamp}:${rawBody}` keyed by the Slack
 * signing secret and compares it (constant-time) to the X-Slack-Signature
 * header. Also rejects timestamps older than 5 minutes to prevent replay.
 *
 * Caller must read the raw request body BEFORE calling this — JSON.parse +
 * re-stringify will not produce a byte-identical body and the signature will
 * not match.
 */

import crypto from "crypto";

const REPLAY_WINDOW_SECONDS = 60 * 5;

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

export function verifySlackSignature(opts: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string | undefined;
}): VerifyResult {
  const { rawBody, timestamp, signature, signingSecret } = opts;

  if (!signingSecret) {
    return { valid: false, reason: "SLACK_SIGNING_SECRET not configured" };
  }
  if (!timestamp || !signature) {
    return { valid: false, reason: "Missing X-Slack-Request-Timestamp or X-Slack-Signature header" };
  }

  // Replay protection — reject requests older than 5 minutes
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: "Invalid timestamp" };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: `Timestamp too old (${ageSeconds}s)` };
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const computed = "v0=" + crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");

  // Constant-time compare. Buffers must be same length for timingSafeEqual,
  // so fall through on length mismatch.
  if (computed.length !== signature.length) {
    return { valid: false, reason: "Signature length mismatch" };
  }
  const match = crypto.timingSafeEqual(
    Buffer.from(computed, "utf8"),
    Buffer.from(signature, "utf8"),
  );

  return match ? { valid: true } : { valid: false, reason: "Signature mismatch" };
}
