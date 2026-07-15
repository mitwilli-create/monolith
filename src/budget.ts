import type { BudgetStatus, LedgerEntry, Profile } from "./types.js";
import { newId, readJson, writeJson } from "./store.js";

const FILE = "ledger.json";

export function loadLedger(): LedgerEntry[] {
  return readJson<LedgerEntry[]>(FILE, []);
}

export function addLedgerEntry(
  entry: Omit<LedgerEntry, "id">,
): LedgerEntry {
  const full: LedgerEntry = { ...entry, id: newId("led") };
  const ledger = loadLedger();
  ledger.push(full);
  writeJson(FILE, ledger);
  return full;
}

/** Deletes only when the entry belongs to `profileId` (Qodo finding 3). */
export function deleteLedgerEntry(id: string, profileId: string): boolean {
  const ledger = loadLedger();
  const next = ledger.filter((e) => !(e.id === id && e.profileId === profileId));
  if (next.length === ledger.length) return false;
  writeJson(FILE, next);
  return true;
}

export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function spentInMonth(
  ledger: LedgerEntry[],
  profileId: string,
  month: string,
): number {
  return ledger
    .filter(
      (e) =>
        e.profileId === profileId &&
        e.cleared &&
        e.date.slice(0, 7) === month,
    )
    .reduce((sum, e) => sum + e.amountUsd, 0);
}

export function budgetStatus(
  profile: Profile,
  priceUsd: number | null,
  ledger: LedgerEntry[] = loadLedger(),
  now: Date = new Date(),
): BudgetStatus {
  const month = monthKey(now);
  const spentUsd = round2(spentInMonth(ledger, profile.id, month));
  const budgetUsd = profile.budget.monthlyUsd;
  const remainingUsd = round2(budgetUsd - spentUsd);
  const overBudgetIfPurchased =
    priceUsd !== null && priceUsd > remainingUsd;
  return { month, spentUsd, budgetUsd, remainingUsd, priceUsd, overBudgetIfPurchased };
}

/** null when unpriced OR unworn: "$450/wear" on a never-worn piece reads as a bug. */
export function costPerWear(priceUsd: number | undefined, wearCount: number): number | null {
  if (priceUsd === undefined || priceUsd <= 0 || wearCount <= 0) return null;
  return round2(priceUsd / wearCount);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
