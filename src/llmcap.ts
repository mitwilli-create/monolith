// Per-user daily ceiling on LLM-backed work in multi-user mode. In-memory
// by design: it protects the host's Anthropic bill from a runaway beta
// account, not from an adversary — a restart resetting the counters is an
// acceptable failure for a handful of invited strangers.

import { LLM_DAILY_CAP, MULTIUSER } from "./config.js";

const used = new Map<string, { day: string; count: number }>();

/**
 * Try to spend `cost` LLM calls for `userId` today. Returns what remains
 * (allowed=false leaves the counter untouched). Single-user local mode is
 * never capped — the owner is paying their own bill.
 */
export function spendLlm(
  userId: string | null,
  cost: number,
  today = new Date().toISOString().slice(0, 10),
): { allowed: boolean; remaining: number } {
  if (!Number.isFinite(cost) || cost < 0) {
    throw new RangeError("cost must be a finite, non-negative number");
  }
  if (!MULTIUSER || userId === null) return { allowed: true, remaining: Number.POSITIVE_INFINITY };
  // Yesterday's entries are dead weight on a long-lived host: drop them
  // whenever the day advances past them.
  for (const [key, entry] of used) {
    if (entry.day !== today) used.delete(key);
  }
  const count = used.get(userId)?.count ?? 0;
  if (count + cost > LLM_DAILY_CAP) {
    return { allowed: false, remaining: Math.max(0, LLM_DAILY_CAP - count) };
  }
  used.set(userId, { day: today, count: count + cost });
  return { allowed: true, remaining: LLM_DAILY_CAP - count - cost };
}
