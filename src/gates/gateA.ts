// GATE A: BUDGET + INVENTORY AUDIT.
// Budget position, campaign dormancy windows, inventory clash detection.

import type {
  BudgetStatus,
  Candidate,
  GateFinding,
  GateResult,
  Item,
  Profile,
} from "../types.js";
import { findClashes } from "../inventory.js";

export function runGateA(
  profile: Profile,
  candidate: Candidate,
  budget: BudgetStatus,
  inventory: Item[],
  now: Date = new Date(),
): GateResult {
  const violations: GateFinding[] = [];
  const notes: GateFinding[] = [];

  // Budget position
  if (candidate.priceUsd === null) {
    notes.push({
      code: "PRICE_UNKNOWN",
      message:
        "Price not extractable. Capital impact unverified. Confirm before purchase.",
      source: "your ledger (CAPITAL tab)",
    });
  } else if (budget.overBudgetIfPurchased) {
    const policyNote = profile.budget.hardStop
      ? "Policy: HARD STOP. Switch to ADVISORY in CAPITAL to make this a warning instead."
      : "Policy: ADVISORY. Passing with a warning; switch to HARD STOP in CAPITAL to block over-budget buys.";
    const finding: GateFinding = {
      code: "OVER_BUDGET",
      message: `$${candidate.priceUsd.toFixed(0)} exceeds remaining ${budget.month} allocation ($${budget.remainingUsd.toFixed(0)} of $${budget.budgetUsd.toFixed(0)}). ${policyNote}`,
      source: "your ledger (CAPITAL tab)",
    };
    if (profile.budget.hardStop) violations.push(finding);
    else notes.push(finding);
  } else {
    notes.push({
      code: "BUDGET_CLEAR",
      message: `Capital available: $${budget.remainingUsd.toFixed(0)} remaining in ${budget.month}. Post-purchase: $${(budget.remainingUsd - candidate.priceUsd).toFixed(0)}.`,
      source: "your ledger (CAPITAL tab)",
    });
  }

  // Campaign temporal gates (dormant unless a campaign is configured)
  const c = profile.campaign;
  if (c) {
    const month = now.getMonth() + 1;
    if (c.dormantMonths.includes(month)) {
      violations.push({
        code: "DORMANCY",
        message: `Dormancy window active (month ${month}). Non-emergency acquisitions frozen per campaign "${c.platform} → $${c.targetUsd}".`,
        source: "your campaign settings",
      });
    } else if (c.pushMonths.includes(month)) {
      notes.push({
        code: "PUSH_WINDOW",
        message: `Active spend window. Campaign gap: $${(c.targetUsd - c.clearedUsd).toFixed(0)} by ${c.deadline}. ${c.promoNotes}`,
        source: "your campaign settings",
      });
    }
    if (
      c.platform &&
      candidate.platform &&
      candidate.platform.toLowerCase() !== c.platform.toLowerCase()
    ) {
      violations.push({
        code: "OFF_PLATFORM",
        message: `Off-platform spend (${candidate.platform}). Campaign requires 100% of capital through ${c.platform}.`,
        source: "your campaign settings",
      });
    }
  }

  // Inventory clash
  const clashes = findClashes(candidate, inventory);
  for (const clash of clashes) {
    violations.push({
      code: "INVENTORY_CLASH",
      message: `Near-identical asset already owned: ${clash.brand}, ${clash.name}${clash.acquiredAt ? ` (acquired ${clash.acquiredAt})` : ""}. Redundant acquisition.`,
      source: "your vault (VAULT tab)",
    });
  }

  return {
    gate: "A",
    name: "BUDGET + INVENTORY",
    passed: violations.length === 0,
    violations,
    notes,
  };
}
