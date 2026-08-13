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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

const REPO_ROOT = join(import.meta.dirname ?? __dirname, "..");

export type DbTarget = "DEV" | "PROD" | "UNKNOWN";

export interface ScriptEnv {
  url: string;
  serviceRoleKey: string;
  target: DbTarget;
  /** Short project ref (`viahl…`), for log lines. */
  projectRef: string;
}

/** Pull NEXT_PUBLIC_SUPABASE_URL out of a named env file without loading it. */
function urlInEnvFile(fileName: string): string | null {
  const path = join(REPO_ROOT, fileName);
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(
    /^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m,
  );
  return match ? match[1].trim() : null;
}

/**
 * Load `.env.local`, derive which database it points at, and say so out loud.
 * Every script that touches Supabase should call this instead of `config()`.
 */
export function loadScriptEnv(): ScriptEnv {
  config({ path: join(REPO_ROOT, ".env.local") });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url) {
    console.error("✗ NEXT_PUBLIC_SUPABASE_URL is unset — is .env.local present?");
    process.exit(1);
  }

  const prodUrl = urlInEnvFile(".env.local.prod");
  const devUrl = urlInEnvFile(".env.local.dev");
  const target: DbTarget =
    prodUrl && url === prodUrl ? "PROD" : devUrl && url === devUrl ? "DEV" : "UNKNOWN";

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
  if (!intendsWrite) return;
  if (env.target === "DEV") return;
  if (process.argv.includes("--prod-write")) {
    console.log(`✓ --prod-write acknowledged — writing to ${env.target} (${env.projectRef}).`);
    return;
  }
  console.error(
    `\n✗ REFUSING TO WRITE to ${env.target} (${env.projectRef}) without acknowledgement.\n` +
      `  If this is deliberate, re-run with --prod-write.\n` +
      `  If it is not, switch first:  ./scripts/use-db.sh dev\n`,
  );
  process.exit(1);
}
