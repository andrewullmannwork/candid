/**
 * scripts/_env.ts — shared environment resolution for one-off scripts (S313).
 *
 * THE PROBLEM. ~160 scripts call `config({ path: ".env.local" })` and TWO of
 * them print which database that turned out to be. Post-OPS.9 `.env.local` is
 * whichever project `scripts/use-db.sh` last copied into place — DEV by
 * default, PROD after a deliberate switch — so the identical command reads (or
 * WRITES) a different database depending on state left behind by an earlier
 * task. `scripts/flags/flag-state.ts` documented itself as "PROD ground truth"
 * for two months while reading DEV.
 *
 * WHAT THIS IS NOT. It is NOT a second way to choose the database.
 * `./scripts/use-db.sh dev|prod` remains the ONLY switch — a competing
 * mechanism could disagree with it, which is a worse bug than the one being
 * fixed. What this adds is the ANNOUNCEMENT (every run states the project it
 * reached) and, for writes, an explicit ACKNOWLEDGEMENT.
 *
 * HOW THE TARGET IS DERIVED. By comparing the live URL against the URLs inside
 * the `.env.local.prod` / `.env.local.dev` files `use-db.sh` already copies
 * from. Derived from existing state — no hardcoded project ref, no new field
 * to fall out of sync. If neither matches (or the files are absent) the target
 * is UNKNOWN, and UNKNOWN is treated as PROD for write purposes: fail-closed.
 *
 * USAGE
 *   const env = loadScriptEnv();                  // read-only script
 *   const env = loadScriptEnv();                  // write script:
 *   requireWriteAck(env, WRITE);                  // exits 1 on PROD w/o ack
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { config } from "dotenv";

// Resolved from THIS module's location, not cwd, so a script run from a
// subdirectory still finds the repo's env files. `new URL("..", …)` is the
// portable ESM idiom — `import.meta.dirname` needs Node 20.11+, and pairing it
// with a `?? __dirname` fallback only LOOKS safe: in ESM the fallback throws a
// ReferenceError rather than falling back.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export type DbTarget = "DEV" | "PROD" | "UNKNOWN";

export interface ScriptEnv {
  url: string;
  serviceRoleKey: string;
  target: DbTarget;
  /** Short project ref (`viahl…`), for log lines. */
  projectRef: string;
}

/**
 * PURE — which database is this URL? Extracted from the IO so the CI fixture
 * (scripts/calibration/fixtures/ops/script-env.ts) can pin the truth table,
 * including the fail-closed cases no type can express. A refactor that inverts
 * the UNKNOWN default would otherwise pass tsc, pass lint, and silently make
 * every PROD write unguarded.
 *
 * PROD is tested FIRST on purpose: if the two env files ever hold the same URL
 * (a bad copy), the answer must be PROD, not DEV.
 */
export function resolveDbTarget(
  url: string,
  prodUrl: string | null,
  devUrl: string | null,
): DbTarget {
  if (prodUrl && url === prodUrl) return "PROD";
  if (devUrl && url === devUrl) return "DEV";
  return "UNKNOWN";
}

/**
 * PURE — may this write proceed? "allow" | "refuse".
 * A dry run is never gated; DEV is never gated; everything else needs the ack.
 * UNKNOWN refuses, which is the whole fail-closed contract.
 */
export function writeAckVerdict(
  target: DbTarget,
  intendsWrite: boolean,
  hasAck: boolean,
): "allow" | "refuse" {
  if (!intendsWrite) return "allow";
  if (target === "DEV") return "allow";
  return hasAck ? "allow" : "refuse";
}

/** Pull NEXT_PUBLIC_SUPABASE_URL out of a named env file without loading it. */
function urlInEnvFile(fileName: string): string | null {
  try {
    const match = readFileSync(join(REPO_ROOT, fileName), "utf8").match(
      /^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m,
    );
    return match ? match[1].trim() : null;
  } catch {
    // Absent or unreadable — the caller falls through to UNKNOWN, which is
    // treated as PROD for writes. Fail-closed by construction.
    return null;
  }
}

/**
 * Load `.env.local`, derive which database it points at, and say so out loud.
 * Every script that touches Supabase should call this instead of `config()`.
 */
export function loadScriptEnv(): ScriptEnv {
  // `quiet` suppresses dotenv's own "injecting env (28) … tip:" line. The
  // banner below is the whole point of this module; a library log printed
  // immediately above it is what the banner has to compete with.
  config({ path: join(REPO_ROOT, ".env.local"), quiet: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url) {
    console.error("✗ NEXT_PUBLIC_SUPABASE_URL is unset — is .env.local present?");
    process.exit(1);
  }

  const target = resolveDbTarget(
    url,
    urlInEnvFile(".env.local.prod"),
    urlInEnvFile(".env.local.dev"),
  );

  const projectRef = url.replace(/^https?:\/\//, "").split(".")[0];

  const banner =
    target === "PROD"
      ? `⚠️  DB: PROD (${projectRef}) — production data`
      : target === "DEV"
        ? `DB: DEV (${projectRef})`
        : `⚠️  DB: UNKNOWN (${projectRef}) — matches neither .env.local.prod nor .env.local.dev; treated as PROD for writes`;
  console.log(banner);

  return { url, serviceRoleKey, target, projectRef };
}

/**
 * Gate a WRITE. `use-db.sh prod` prints "Do NOT run resets or destructive
 * tests" — this enforces it instead of hoping it was read. A PROD (or UNKNOWN)
 * target requires `--prod-write` on the command line; DEV passes through.
 *
 * `intendsWrite` is the script's own dry-run/write switch, so a dry run
 * against PROD stays frictionless and only real writes are gated.
 */
export function requireWriteAck(env: ScriptEnv, intendsWrite: boolean): void {
  const hasAck = process.argv.includes("--prod-write");
  if (writeAckVerdict(env.target, intendsWrite, hasAck) === "allow") {
    if (intendsWrite && env.target !== "DEV") {
      console.log(`✓ --prod-write acknowledged — writing to ${env.target} (${env.projectRef}).`);
    }
    return;
  }
  console.error(
    `\n✗ REFUSING TO WRITE to ${env.target} (${env.projectRef}) without acknowledgement.\n` +
      `  If this is deliberate, re-run with --prod-write.\n` +
      `  If it is not, switch first:  ./scripts/use-db.sh dev\n`,
  );
  process.exit(1);
}
