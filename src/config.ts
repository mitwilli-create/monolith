import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const SEED_DIR = path.join(ROOT, "seed");
export const PUBLIC_DIR = path.join(ROOT, "public");

/** Minimal .env loader: no dependency, never overrides real env. */
export function loadDotEnv(): void {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

// Overridable so a hosted deploy can point at a mounted volume; defaults to
// the repo-local gitignored data/ exactly as before.
export const DATA_DIR = process.env.MONOLITH_DATA_DIR || path.join(ROOT, "data");

export const PORT = clampInt(process.env.MONOLITH_PORT, 4600, 1024, 65535);
export const MODEL = process.env.MONOLITH_MODEL || "claude-opus-4-8";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
/**
 * Loopback by default (Qodo r2 finding 4): the API has no authentication,
 * so network exposure must be an explicit decision: MONOLITH_BIND=0.0.0.0
 * for LAN/phone use, ideally behind an authenticated tunnel.
 */
export const BIND = process.env.MONOLITH_BIND || "127.0.0.1";

// Invisible-in ingestion (Gmail OAuth). Both empty = the feature is off and
// the UI says how to turn it on. The redirect URI must match the one
// registered on the Google OAuth client.
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
export const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/ingest/oauth/callback`;

// ---------- multi-user mode (Sprint B) ----------
// Both Clerk keys set = hosted multi-user mode: every /api request must carry
// a Clerk session, and all data resolves to data/users/<userId>/. Neither
// set = single-user local mode, byte-identical to the app before Sprint B.
// Trimmed before presence checks: a whitespace-padded secret must not
// count as "Clerk configured" and sneak past the public-bind guard below.
export const CLERK_PUBLISHABLE_KEY = (process.env.CLERK_PUBLISHABLE_KEY || "").trim();
export const CLERK_SECRET_KEY = (process.env.CLERK_SECRET_KEY || "").trim();
const hasClerk = CLERK_PUBLISHABLE_KEY.length > 0 && CLERK_SECRET_KEY.length > 0;
// Half a Clerk config is a misconfiguration, not a mode: fail at startup
// rather than silently booting the unauthenticated single-user app.
if ((CLERK_PUBLISHABLE_KEY.length > 0) !== (CLERK_SECRET_KEY.length > 0)) {
  throw new Error("CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY must be set together.");
}

/**
 * Dev-only stand-in for Clerk so the multi-user surface (sign-in gate,
 * intake, per-user isolation) can be exercised without real keys: requests
 * are attributed to the `monolith-fake-user` cookie (default "demo").
 * Refused when any real Clerk key is present — it must never weaken a
 * real deployment.
 */
export const FAKE_AUTH = process.env.MONOLITH_FAKE_AUTH === "1";
if (FAKE_AUTH && (CLERK_PUBLISHABLE_KEY.length > 0 || CLERK_SECRET_KEY.length > 0)) {
  throw new Error("MONOLITH_FAKE_AUTH cannot be combined with real Clerk keys.");
}

export const MULTIUSER = hasClerk || FAKE_AUTH;

// A non-loopback bind without REAL auth (fake auth is a cookie anyone can
// set) is never legitimate: refuse to start. No override — for phone use
// keep the loopback bind and reach it through an authenticated tunnel
// (e.g. Tailscale), or set up Clerk.
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!hasClerk && !LOOPBACK_BINDS.has(BIND)) {
  throw new Error(
    `Refusing to bind ${BIND} without Clerk auth: the API would be public and unauthenticated. ` +
      "Set both Clerk keys, or keep the loopback bind and use an authenticated tunnel for remote access.",
  );
}

/** Comma-separated origins Clerk should accept tokens for (CSRF hardening). */
export const CLERK_AUTHORIZED_PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Per-user daily ceiling on LLM-backed calls (extraction, ingest sync) in
 * multi-user mode, so a stranger's beta account can't run up the host's
 * Anthropic bill. Local single-user mode is never capped.
 */
export const LLM_DAILY_CAP = clampInt(process.env.MONOLITH_LLM_DAILY_CAP, 60, 1, 100_000);

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
