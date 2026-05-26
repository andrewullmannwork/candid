#!/usr/bin/env tsx
/**
 * Bills-E.1 truncation telemetry fixture (Ship Gate G4; manually re-runnable).
 *
 * Tests the pure helpers + the recordBillTruncation integration with mocked
 * Supabase client + mocked fetch. Verifies the payload shape, Slack message
 * text contents, channel-ID env override, and end-to-end non-fatal behavior
 * when both writes succeed AND when they fail.
 *
 * Run: npx tsx scripts/bills-e-1-truncation-telemetry-fixture.ts
 *
 * CI wiring deferred to fixture-CI-harness session per existing retroactive
 * Ship Gate convention (see plans/block_ship_gate.md §"Follow-up Obligations").
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSlackMessageText,
  buildTruncationPayload,
  recordBillTruncation,
  resolveSlackChannelId,
  type BillTruncationEvent,
} from "../src/lib/billing/truncation-telemetry";

let assertionsRun = 0;
let assertionsPassed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  assertionsRun += 1;
  if (condition) {
    assertionsPassed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

function header(name: string): void {
  console.log(`\n${name}`);
}

async function main() {
// ---------------------------------------------------------------------------
// 1. buildTruncationPayload — pure helper
// ---------------------------------------------------------------------------
header("[1] buildTruncationPayload — payload shape");

const fixedNow = new Date("2026-05-26T18:30:00.000Z");
const payload = buildTruncationPayload({
  billType: "eob",
  userId: "user-uuid-123",
  inputTokensEstimate: 28000,
  maxTokensAttempted: 32000,
  ocrTextLength: 142000,
  now: () => fixedNow,
});

assert("fired_at uses injected clock", payload.fired_at === "2026-05-26T18:30:00.000Z", payload.fired_at);
assert("billType preserved", payload.billType === "eob");
assert("userId preserved", payload.userId === "user-uuid-123");
assert("stop_reason is max_tokens", payload.stop_reason === "max_tokens");
assert("input_tokens_estimate preserved", payload.input_tokens_estimate === 28000);
assert("max_tokens_attempted preserved", payload.max_tokens_attempted === 32000);
assert("ocr_text_length preserved", payload.ocr_text_length === 142000);
assert("outcome is total_parse_failure", payload.outcome === "total_parse_failure");

// ---------------------------------------------------------------------------
// 2. buildSlackMessageText — Slack message contents
// ---------------------------------------------------------------------------
header("[2] buildSlackMessageText — message contents");

const slackText = buildSlackMessageText("doc-uuid-abc", payload);

assert("contains warning emoji", slackText.includes(":warning:"));
assert("contains documentId", slackText.includes("doc-uuid-abc"));
assert("contains userId", slackText.includes("user-uuid-123"));
assert("contains billType eob", slackText.includes("`eob`"));
assert("contains formatted input_tokens_estimate", slackText.includes("28,000"));
assert("contains formatted max_tokens_attempted", slackText.includes("32,000"));
assert("contains formatted ocr_text_length", slackText.includes("142,000"));
assert("contains admin URL", slackText.includes("https://www.candidclaim.com/admin/parse-audit-runs"));
assert("contains deferred-fix pointer", slackText.includes("Bills-E.1"));

// itemized_bill variant
const itemizedPayload = buildTruncationPayload({
  billType: "itemized_bill",
  userId: "user-uuid-456",
  inputTokensEstimate: 35000,
  maxTokensAttempted: 32000,
  ocrTextLength: 200000,
  now: () => fixedNow,
});
const itemizedSlackText = buildSlackMessageText("doc-uuid-xyz", itemizedPayload);
assert("itemized_bill variant renders billType", itemizedSlackText.includes("`itemized_bill`"));

// ---------------------------------------------------------------------------
// 3. resolveSlackChannelId — env override + default
// ---------------------------------------------------------------------------
header("[3] resolveSlackChannelId — env override");

const originalEnv = process.env.SLACK_BACKEND_OPS_CHANNEL_ID;

delete process.env.SLACK_BACKEND_OPS_CHANNEL_ID;
assert("default to C0B6XUUD3NU when env unset", resolveSlackChannelId() === "C0B6XUUD3NU");

process.env.SLACK_BACKEND_OPS_CHANNEL_ID = "C9OVERRIDE99";
assert("env override takes precedence", resolveSlackChannelId() === "C9OVERRIDE99");

// restore
if (originalEnv === undefined) {
  delete process.env.SLACK_BACKEND_OPS_CHANNEL_ID;
} else {
  process.env.SLACK_BACKEND_OPS_CHANNEL_ID = originalEnv;
}

// ---------------------------------------------------------------------------
// 4. recordBillTruncation — happy path (mock supabase + fetch)
// ---------------------------------------------------------------------------
header("[4] recordBillTruncation — happy path with mocks");

interface UpdateCall {
  table: string;
  metadata: unknown;
  where: { column: string; value: string };
}
interface SelectCall {
  table: string;
  columns: string;
  where: { column: string; value: string };
}

const updateCalls: UpdateCall[] = [];
const selectCalls: SelectCall[] = [];
let currentTable = "";

const mockSupabase: SupabaseClient = {
  from(table: string) {
    currentTable = table;
    return {
      select(columns: string) {
        return {
          eq(column: string, value: string) {
            return {
              async maybeSingle() {
                selectCalls.push({ table: currentTable, columns, where: { column, value } });
                return { data: { metadata: { existing_key: "preserved" } }, error: null };
              },
            };
          },
        };
      },
      update(payload: { metadata: unknown }) {
        return {
          async eq(column: string, value: string) {
            updateCalls.push({
              table: currentTable,
              metadata: payload.metadata,
              where: { column, value },
            });
            return { error: null };
          },
        };
      },
    } as unknown as ReturnType<SupabaseClient["from"]>;
  },
} as unknown as SupabaseClient;

interface FetchCall {
  url: string;
  body: { channel?: string; text?: string; mrkdwn?: boolean };
  headers: Record<string, string>;
}
const fetchCalls: FetchCall[] = [];

const mockFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.toString();
  fetchCalls.push({
    url,
    body: JSON.parse(String(init?.body ?? "{}")),
    headers: init?.headers as Record<string, string>,
  });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

const previousToken = process.env.SLACK_BOT_TOKEN;
process.env.SLACK_BOT_TOKEN = "xoxb-test-token-fixture";

await recordBillTruncation({
  documentId: "doc-happy-path",
  userId: "user-happy",
  billType: "eob",
  inputTokensEstimate: 30000,
  maxTokensAttempted: 32000,
  ocrTextLength: 180000,
  supabase: mockSupabase,
  fetchImpl: mockFetch,
  now: () => fixedNow,
});

assert("read existing metadata once", selectCalls.length === 1);
assert("read from documents table", selectCalls[0]?.table === "documents");
assert("read by documentId", selectCalls[0]?.where.value === "doc-happy-path");

assert("update metadata once", updateCalls.length === 1);
assert("update documents table", updateCalls[0]?.table === "documents");
assert("update by documentId", updateCalls[0]?.where.value === "doc-happy-path");

const writtenMetadata = updateCalls[0]?.metadata as Record<string, unknown>;
assert("preserves existing metadata key (read-spread-write)", writtenMetadata?.existing_key === "preserved");
assert("adds bill_truncation key", !!writtenMetadata?.bill_truncation);
const writtenEvent = writtenMetadata?.bill_truncation as BillTruncationEvent;
assert("written event preserves userId", writtenEvent?.userId === "user-happy");
assert("written event preserves stop_reason", writtenEvent?.stop_reason === "max_tokens");

assert("Slack postMessage called once", fetchCalls.length === 1);
assert("Slack URL correct", fetchCalls[0]?.url === "https://slack.com/api/chat.postMessage");
assert("Slack channel from env or default", fetchCalls[0]?.body.channel === "C0B6XUUD3NU");
assert("Slack mrkdwn enabled", fetchCalls[0]?.body.mrkdwn === true);
assert("Slack message contains documentId", fetchCalls[0]?.body.text?.includes("doc-happy-path") ?? false);

// ---------------------------------------------------------------------------
// 5. recordBillTruncation — no Slack token (telemetry still writes to DB)
// ---------------------------------------------------------------------------
header("[5] recordBillTruncation — SLACK_BOT_TOKEN unset");

updateCalls.length = 0;
selectCalls.length = 0;
fetchCalls.length = 0;
delete process.env.SLACK_BOT_TOKEN;

await recordBillTruncation({
  documentId: "doc-no-slack",
  userId: "user-no-slack",
  billType: "itemized_bill",
  inputTokensEstimate: 40000,
  maxTokensAttempted: 32000,
  ocrTextLength: 250000,
  supabase: mockSupabase,
  fetchImpl: mockFetch,
  now: () => fixedNow,
});

assert("metadata write still happens without Slack token", updateCalls.length === 1);
assert("Slack fetch NOT called when token missing", fetchCalls.length === 0);

// ---------------------------------------------------------------------------
// 6. recordBillTruncation — non-fatal on Supabase error
// ---------------------------------------------------------------------------
header("[6] recordBillTruncation — non-fatal on Supabase write error");

const erroringSupabase: SupabaseClient = {
  from(_table: string) {
    return {
      select(_columns: string) {
        return {
          eq(_column: string, _value: string) {
            return {
              async maybeSingle() {
                return { data: null, error: { message: "simulated read failure" } };
              },
            };
          },
        };
      },
      update(_payload: { metadata: unknown }) {
        return {
          async eq(_column: string, _value: string) {
            return { error: { message: "simulated write failure" } };
          },
        };
      },
    } as unknown as ReturnType<SupabaseClient["from"]>;
  },
} as unknown as SupabaseClient;

let threw = false;
try {
  await recordBillTruncation({
    documentId: "doc-error",
    userId: "user-error",
    billType: "eob",
    inputTokensEstimate: 30000,
    maxTokensAttempted: 32000,
    ocrTextLength: 180000,
    supabase: erroringSupabase,
    fetchImpl: mockFetch,
    now: () => fixedNow,
  });
} catch {
  threw = true;
}
assert("does not throw on Supabase failure", !threw);

// ---------------------------------------------------------------------------
// 7. recordBillTruncation — non-fatal on Slack fetch error
// ---------------------------------------------------------------------------
header("[7] recordBillTruncation — non-fatal on Slack fetch throw");

process.env.SLACK_BOT_TOKEN = "xoxb-test-token-fixture";

const throwingFetch: typeof fetch = async () => {
  throw new Error("simulated network failure");
};

threw = false;
try {
  await recordBillTruncation({
    documentId: "doc-slack-throw",
    userId: "user-slack-throw",
    billType: "eob",
    inputTokensEstimate: 30000,
    maxTokensAttempted: 32000,
    ocrTextLength: 180000,
    supabase: mockSupabase,
    fetchImpl: throwingFetch,
    now: () => fixedNow,
  });
} catch {
  threw = true;
}
assert("does not throw on Slack fetch failure", !threw);

// restore
if (previousToken === undefined) {
  delete process.env.SLACK_BOT_TOKEN;
} else {
  process.env.SLACK_BOT_TOKEN = previousToken;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(
  `\n${assertionsPassed}/${assertionsRun} assertions passed ${
    assertionsPassed === assertionsRun ? "✓" : "✗"
  }`,
);
process.exit(assertionsPassed === assertionsRun ? 0 : 1);
}

main().catch((err) => {
  console.error("Fixture threw unexpectedly:", err);
  process.exit(1);
});
