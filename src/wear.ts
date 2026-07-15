// One-tap wear log: a day's outfit in one gesture. Everything here is plain
// code — the prediction is a recency-frequency ranking over the owner's own
// wear history, never a model guess — and the daily record keeps
// Item.wearCount honest by adjusting it by diff on re-log.

import { newId, readJson, writeJson } from "./store.js";
import type { Item } from "./types.js";

const FILE = "wear-log.json";

// The wear-log route is a read-modify-write across two files (inventory
// wearCounts + the day's record). Serialize it — mirrors quests.ts's
// withQuestsLock — so two near-simultaneous logs (e.g. a double-tap) can't
// compute deltas from the same stale snapshot and clobber each other.
let wearChain: Promise<unknown> = Promise.resolve();

export function withWearLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = wearChain.then(fn, fn);
  wearChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One calendar day's outfit. `skipped` marks a deliberate "not today". */
export interface WearRecord {
  id: string;
  profileId: string;
  date: string; // YYYY-MM-DD
  itemIds: string[];
  skipped: boolean;
}

export function loadWearLog(): WearRecord[] {
  return readJson<WearRecord[]>(FILE, []);
}

export function saveWearLog(log: WearRecord[]): void {
  writeJson(FILE, log);
}

export function todayKey(now: Date = new Date()): string {
  // Local calendar day: an evening log at 23:50 belongs to that day.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function recordFor(
  log: WearRecord[],
  profileId: string,
  date: string,
): WearRecord | undefined {
  return log.find((r) => r.profileId === profileId && r.date === date);
}

/**
 * Upsert a day's outfit and return the per-item wearCount deltas the caller
 * must apply (+1 newly worn, -1 removed on re-log). Pure on (log, items):
 * the caller owns persistence, so this stays unit-testable end to end.
 */
export function upsertWear(
  log: WearRecord[],
  profileId: string,
  date: string,
  itemIds: string[],
  ownedIds: Set<string>,
): { log: WearRecord[]; record: WearRecord; deltas: Map<string, number> } {
  const unique = [...new Set(itemIds)];
  const unknown = unique.filter((id) => !ownedIds.has(id));
  if (unknown.length) {
    throw new Error(`Unknown item id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  const prev = recordFor(log, profileId, date);
  const before = new Set(prev && !prev.skipped ? prev.itemIds : []);
  const after = new Set(unique);
  const deltas = new Map<string, number>();
  for (const id of after) if (!before.has(id)) deltas.set(id, 1);
  // Only decrement items that still exist: a piece deleted from the vault
  // after being logged must not crash the update loop on re-log.
  for (const id of before) if (!after.has(id) && ownedIds.has(id)) deltas.set(id, -1);

  const record: WearRecord = prev
    ? { ...prev, itemIds: unique, skipped: false }
    : { id: newId("wear"), profileId, date, itemIds: unique, skipped: false };
  const next = prev ? log.map((r) => (r.id === prev.id ? record : r)) : [...log, record];
  return { log: next, record, deltas };
}

/** Mark a day deliberately unlogged. Never touches wear counts. */
export function skipWear(
  log: WearRecord[],
  profileId: string,
  date: string,
): { log: WearRecord[]; record: WearRecord } {
  const prev = recordFor(log, profileId, date);
  if (prev && !prev.skipped && prev.itemIds.length) {
    // A real log already exists; skipping must not erase it.
    return { log, record: prev };
  }
  const record: WearRecord = prev
    ? { ...prev, skipped: true }
    : { id: newId("wear"), profileId, date, itemIds: [], skipped: true };
  const next = prev ? log.map((r) => (r.id === prev.id ? record : r)) : [...log, record];
  return { log: next, record };
}

const PREDICTION_WINDOW_DAYS = 45;

/**
 * Recognition, not recall: the 3-6 pieces the owner most plausibly wore
 * today, ranked by recency-weighted frequency over the last 45 days of
 * their own log (each past wear contributes 1/(1+daysAgo)). Cold start
 * falls back to wear counts, then newest acquisitions, so the very first
 * prompt is still one tap. Deterministic; ties broken by stable ordering.
 */
export function predictStack(
  items: Item[],
  log: WearRecord[],
  profileId: string,
  date: string,
  max = 6,
  min = 3,
): Item[] {
  const mine = items.filter((i) => i.profileId === profileId);
  if (!mine.length) return [];

  const dateMs = new Date(`${date}T12:00:00`).getTime();
  const score = new Map<string, number>();
  for (const r of log) {
    if (r.profileId !== profileId || r.skipped || r.date >= date) continue;
    const daysAgo = Math.floor((dateMs - new Date(`${r.date}T12:00:00`).getTime()) / 86_400_000);
    if (daysAgo < 0 || daysAgo > PREDICTION_WINDOW_DAYS) continue;
    for (const id of r.itemIds) {
      score.set(id, (score.get(id) ?? 0) + 1 / (1 + daysAgo));
    }
  }

  const ranked = [...mine].sort((a, b) => {
    const sa = score.get(a.id) ?? 0;
    const sb = score.get(b.id) ?? 0;
    if (sb !== sa) return sb - sa;
    if (b.wearCount !== a.wearCount) return b.wearCount - a.wearCount;
    return (b.acquiredAt ?? "").localeCompare(a.acquiredAt ?? "");
  });

  const n = Math.max(Math.min(max, ranked.length), Math.min(min, ranked.length));
  return ranked.slice(0, n);
}
