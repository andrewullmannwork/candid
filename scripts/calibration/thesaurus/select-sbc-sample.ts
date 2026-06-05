/**
 * Phase 0 GT-build — deterministic stratified SBC sample selector + OCR cache.
 *
 * Walks ~/Desktop/SBC_downloads/, parses HIOS(14)/issuer/state/metal from each filename,
 * stratifies (round-robin across issuers, metal-diverse within issuer; targets >=12 issuers,
 * >=8 states), force-includes the remaining Clarity (13219NH*), picks N new SBCs, matches each
 * to its PROD canonical via canonical_plans.hios_id, OCRs via pdfjs (extractTextFromPDFLayer —
 * NEVER the production parser; independence gate), and writes:
 *   - <freeze-dir>/sbc-sample-manifest.json   (frozen selection + identity match)
 *   - <freeze-dir>/ocr-cache/<docId>.txt       (resumable: skipped if present & non-trivial)
 *
 * Deterministic (filename-sorted; no randomness). Read-only on PROD.
 * Usage: npx tsx scripts/calibration/thesaurus/select-sbc-sample.ts <freeze-dir> [count=36]
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- one-shot selection builder; Supabase query-builder anys */
import { config } from "dotenv";
import { resolve, join } from "path";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "fs";
import { homedir } from "os";
import { createClient } from "@supabase/supabase-js";
import { extractTextFromPDFLayer } from "@/lib/ocr/pdf-text-extract";

config({ path: resolve(process.cwd(), ".env.local") });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });

const SBC_DIR = join(homedir(), "Desktop", "SBC_downloads");
const DONE_HIOS = new Set(["13219NH0010001", "13219NH0010005"]); // 2 Clarity already in validate-small
const HIOS_RE = /^(\d{5})([A-Z]{2})(\d{7})$/;
const MIN_OCR_CHARS = 2000;

type Parsed = { file: string; hios14: string; issuer: string; state: string; metal: string };

function parseMetal(file: string): string {
  const m = file.toLowerCase().match(/catastrophic|platinum|gold|silver|expanded[ _-]?bronze|bronze/);
  if (!m) return "unknown";
  return m[0].includes("bronze") ? "bronze" : m[0];
}
function parseFile(file: string): Parsed | null {
  const hios14 = file.split("_")[0];
  const m = hios14.match(HIOS_RE);
  return m ? { file, hios14, issuer: m[1], state: m[2], metal: parseMetal(file) } : null;
}

async function main() {
  const freezeDir = resolve(process.argv[2] ?? ".");
  const count = parseInt(process.argv[3] ?? "36", 10);
  const ocrDir = join(freezeDir, "ocr-cache");
  if (!existsSync(ocrDir)) mkdirSync(ocrDir, { recursive: true });

  // ── parse + filter ──
  const parsed = readdirSync(SBC_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map(parseFile)
    .filter((p): p is Parsed => p !== null && !DONE_HIOS.has(p.hios14))
    .sort((a, b) => a.file.localeCompare(b.file)); // deterministic

  const byIssuer = new Map<string, Parsed[]>();
  for (const p of parsed) { if (!byIssuer.has(p.issuer)) byIssuer.set(p.issuer, []); byIssuer.get(p.issuer)!.push(p); }
  const issuers = [...byIssuer.keys()].sort();

  // ── stratified pick ──
  const picks: Parsed[] = [];
  const pickedFiles = new Set<string>();
  const issuerMetal = new Set<string>();
  const take = (p: Parsed) => { picks.push(p); pickedFiles.add(p.file); issuerMetal.add(`${p.issuer}|${p.metal}`); };

  for (const p of parsed) { if (picks.length >= count) break; if (p.issuer === "13219" && p.state === "NH") take(p); } // remaining Clarity
  let progress = true;
  while (picks.length < count && progress) {
    progress = false;
    for (const iss of issuers) {
      if (picks.length >= count) break;
      const cand = byIssuer.get(iss)!.find((f) => !pickedFiles.has(f.file) && !issuerMetal.has(`${iss}|${f.metal}`));
      if (cand) { take(cand); progress = true; }
    }
  }
  for (const iss of issuers) { if (picks.length >= count) break; for (const f of byIssuer.get(iss)!) { if (picks.length >= count) break; if (!pickedFiles.has(f.file)) take(f); } }

  // ── identity match: canonical_plans.hios_id ──
  const hiosList = picks.map((p) => p.hios14);
  const canonMap = new Map<string, { id: string; plan_name: string; insurer_id: string | null }>();
  for (let i = 0; i < hiosList.length; i += 100) {
    const { data, error } = await supabase.from("canonical_plans").select("id,plan_name,insurer_id,hios_id").in("hios_id", hiosList.slice(i, i + 100));
    if (error) throw new Error(`canonical_plans: ${error.message}`);
    for (const r of (data ?? []) as any[]) if (r.hios_id) canonMap.set(r.hios_id, { id: r.id, plan_name: r.plan_name, insurer_id: r.insurer_id });
  }
  const insIds = [...new Set([...canonMap.values()].map((c) => c.insurer_id).filter(Boolean) as string[])];
  const insName = new Map<string, string>();
  if (insIds.length) { const { data } = await supabase.from("insurer_catalog").select("id,name").in("id", insIds); for (const r of (data ?? []) as any[]) insName.set(r.id, r.name); }

  // ── OCR (resumable) + manifest ──
  const manifest: any[] = [];
  let matched = 0, ocrFail = 0;
  for (const p of picks) {
    const docId = p.hios14.toLowerCase();
    const ocrPath = join(ocrDir, `${docId}.txt`);
    let chars = existsSync(ocrPath) && statSync(ocrPath).size > MIN_OCR_CHARS ? statSync(ocrPath).size : 0;
    if (chars === 0) {
      try { const { text } = await extractTextFromPDFLayer(readFileSync(join(SBC_DIR, p.file))); writeFileSync(ocrPath, text); chars = text.length; }
      catch { chars = 0; }
    }
    const canon = canonMap.get(p.hios14) ?? null;
    if (canon) matched++;
    if (chars < MIN_OCR_CHARS) ocrFail++;
    manifest.push({
      docId, pdfPath: join(SBC_DIR, p.file), hios14: p.hios14, issuer: p.issuer, state: p.state, metal: p.metal,
      canonicalPlanId: canon?.id ?? null,
      planName: canon?.plan_name ?? p.file.split("_")[1] ?? p.hios14,
      insurer: canon?.insurer_id ? insName.get(canon.insurer_id) ?? "unknown" : "unknown",
      planYear: 2026, ocrPath, ocrChars: chars, ocrLow: chars < MIN_OCR_CHARS,
    });
  }
  writeFileSync(join(freezeDir, "sbc-sample-manifest.json"), JSON.stringify(manifest, null, 2));

  // ── report ──
  const uIss = new Set(picks.map((p) => p.issuer)), uState = new Set(picks.map((p) => p.state)), uMetal = new Set(picks.map((p) => p.metal));
  console.log(`Selected ${picks.length} new SBCs: ${uIss.size} issuers, ${uState.size} states, metals=${[...uMetal].sort().join("/")}`);
  console.log(`Identity match: ${matched}/${picks.length} → canonical (hios_id); ${picks.length - matched} null (B1-forward only)`);
  console.log(`OCR: ${picks.length - ocrFail} ok, ${ocrFail} low-text (<${MIN_OCR_CHARS} chars — flagged ocrLow)`);
  console.log(`States: ${[...uState].sort().join(",")}  | manifest → sbc-sample-manifest.json`);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
