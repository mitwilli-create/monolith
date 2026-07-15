// JSON-file persistence with atomic writes (tmp + rename).
// data/ is the user layer: gitignored, seeded from seed/ on first run.
//
// Multi-user (Sprint B): every function resolves its directory per call via
// activeDataDir(). In single-user local mode that is data/, exactly as
// before. In multi-user mode it is data/users/<userId>/ for the request's
// authenticated user, and any call WITHOUT a user context throws — the
// shared root is unreachable, so a missed middleware can only fail closed,
// never leak one user's rows to another.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, MULTIUSER, SEED_DIR } from "./config.js";
import { currentUserId } from "./user-context.js";

/**
 * Seeds copied into a NEW user's directory on first touch. Deliberately
 * excludes profiles.json: a stranger's profile is born from the intake
 * flow, not from the example profile a local install starts with.
 */
const PER_USER_SEEDS = ["care-protocols.json", "sizing-matrix.json"];

/** Clerk user ids are url-safe; anything else must not become a path. */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Pure resolution logic, exported for tests: (userId, multiuser) → data dir
 * or an Error string explaining the refusal.
 */
export function resolveDataDir(
  userId: string | null,
  multiuser: boolean,
  root: string,
): { dir: string } | { error: string } {
  if (userId !== null) {
    if (!USER_ID_RE.test(userId)) {
      return { error: `Refusing user id that cannot safely name a directory: ${JSON.stringify(userId.slice(0, 40))}` };
    }
    return { dir: path.join(root, "users", userId) };
  }
  if (multiuser) {
    return {
      error:
        "No user context on this request: refusing to touch the shared data dir in multi-user mode.",
    };
  }
  return { dir: root };
}

/** The current caller's data directory, created + seeded on first touch.
 *  Stateless per request (no process-local memory of who was seeded): the
 *  filesystem itself is the record, and existing files are never touched. */
export function activeDataDir(): string {
  const resolved = resolveDataDir(currentUserId(), MULTIUSER, DATA_DIR);
  if ("error" in resolved) throw new Error(resolved.error);
  const dir = resolved.dir;
  if (dir !== DATA_DIR) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(SEED_DIR)) {
      for (const name of PER_USER_SEEDS) {
        const src = path.join(SEED_DIR, name);
        const target = path.join(dir, name);
        if (fs.existsSync(src) && !fs.existsSync(target)) {
          fs.copyFileSync(src, target);
        }
      }
    }
  }
  return dir;
}

export function ensureDataDir(): void {
  fs.mkdirSync(activeDataDir(), { recursive: true });
}

/** Copy any seed file the LOCAL data dir is missing. Never overwrites user
 *  data; multi-user per-user dirs are seeded lazily by activeDataDir(). */
export function seedDataDir(): void {
  if (MULTIUSER) return;
  ensureDataDir();
  if (!fs.existsSync(SEED_DIR)) return;
  for (const name of fs.readdirSync(SEED_DIR)) {
    if (!name.endsWith(".json")) continue;
    const target = path.join(DATA_DIR, name);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(SEED_DIR, name), target);
    }
  }
}

export function readJson<T>(name: string, fallback: T): T {
  const file = path.join(activeDataDir(), name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(name: string, value: unknown): void {
  ensureDataDir();
  const file = path.join(activeDataDir(), name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Append one record to a .jsonl audit log. */
export function appendJsonl(name: string, record: unknown): void {
  ensureDataDir();
  fs.appendFileSync(path.join(activeDataDir(), name), JSON.stringify(record) + "\n");
}

export function readJsonl<T>(name: string, limit?: number): T[] {
  const file = path.join(activeDataDir(), name);
  if (!fs.existsSync(file)) return [];
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const slice = limit ? lines.slice(-limit) : lines;
  const out: T[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip corrupt line rather than fail the whole read
    }
  }
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}
