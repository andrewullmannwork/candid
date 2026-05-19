/**
 * Continuously poll documents table for the most recent gold-80 upload
 * and print state transitions. Exits when status reaches a terminal state
 * (processed, error, cancelled) OR after 5 minutes.
 */
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const startedAt = Date.now();
const MAX_RUNTIME_MS = 5 * 60 * 1000;
const POLL_MS = 2000;

let lastSignature = "";

async function tick(): Promise<boolean> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, file_name, doc_type, classified_type, classification_confidence, status, processing_step, processing_error, metadata")
    .ilike("file_name", "%gold-80%")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) {
    return false;
  }
  const d = data[0];
  // skip the previously-cancelled doc; we want the NEW one
  if (d.id === "2242cf14-1fb5-44bc-ba4e-e2867ff3894f") {
    process.stdout.write(".");
    return false;
  }

  const ageSec = ((Date.now() - startedAt) / 1000).toFixed(0);
  const meta = d.metadata as Record<string, unknown> | null;
  const overrideMeta = meta?.classification_override as Record<string, unknown> | undefined;
  const confirmMeta = meta?.doc_type_confirmation as Record<string, unknown> | undefined;
  const sig = JSON.stringify({
    id: d.id,
    s: d.status,
    ps: d.processing_step,
    dt: d.doc_type,
    ct: d.classified_type,
    cc: d.classification_confidence,
    err: d.processing_error,
    has_override: !!overrideMeta,
    has_confirm: !!confirmMeta,
  });
  if (sig !== lastSignature) {
    lastSignature = sig;
    console.log(`\n[+${ageSec}s] doc ${d.id.slice(0, 8)}...`);
    console.log(`  status: ${d.status}`);
    console.log(`  doc_type: ${d.doc_type} | classified_type: ${d.classified_type} (conf=${d.classification_confidence})`);
    console.log(`  processing_step: ${d.processing_step ?? "null"}`);
    if (d.processing_error) console.log(`  processing_error: ${d.processing_error}`);
    if (overrideMeta) {
      console.log(`  metadata.classification_override: override_reason=${overrideMeta.override_reason} effective=${overrideMeta.effective_doc_type}`);
    }
    if (confirmMeta) {
      console.log(`  metadata.doc_type_confirmation: user_pick=${confirmMeta.user_pick} classifier_pick=${confirmMeta.classifier_pick} options=${JSON.stringify(confirmMeta.options)}`);
    }
  }

  // terminal states
  if (["processed", "error", "cancelled", "rejected"].includes(d.status)) {
    console.log(`\nTerminal state reached: ${d.status}`);
    return true;
  }
  // also stop if awaiting_user_confirmation is hit — that's the modal-rendered checkpoint
  if (d.status === "awaiting_user_confirmation" && lastSignature !== "") {
    // wait for next user action; keep polling
  }
  return false;
}

async function main() {
  console.log("Watching for new gold-80 upload state changes... (Ctrl+C to stop)");
  console.log("(Dots = no new doc yet OR same state as previous tick)\n");
  while (Date.now() - startedAt < MAX_RUNTIME_MS) {
    const done = await tick();
    if (done) {
      console.log("\nExiting watcher.");
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log("\nMax runtime reached. Exiting.");
}

main();
