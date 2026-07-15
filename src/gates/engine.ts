// Verdict engine: runs A → B → C, assembles the verdict, appends the audit log.
// The decision is pure code. The LLM never touches this path.

import type {
  Candidate,
  CareProtocol,
  Decision,
  Item,
  Profile,
  Verdict,
  WeatherDay,
} from "../types.js";
import { runGateA } from "./gateA.js";
import { runGateB } from "./gateB.js";
import { runGateC } from "./gateC.js";
import { budgetStatus, costPerWear, loadLedger } from "../budget.js";
import { loadInventory, assignProtocols } from "../inventory.js";
import { recommendSize } from "../sizing.js";
import { appendJsonl, newId } from "../store.js";
import { loadProtocols } from "../care.js";
import { medianCategoryWears } from "../quests.js";

export interface VerdictDeps {
  inventory?: Item[];
  ledger?: ReturnType<typeof loadLedger>;
  protocols?: CareProtocol[];
  forecast?: WeatherDay[];
  now?: Date;
  persist?: boolean;
}

export function requiredDataMissing(c: Candidate): string[] {
  const missing: string[] = [];
  if (!c.brand.trim()) missing.push("brand");
  if (!c.name.trim()) missing.push("product name");
  if (c.materials.length === 0 && !c.descriptionText.trim()) {
    missing.push("materials or description (climate filter cannot run)");
  }
  return missing;
}

export function runVerdict(
  profile: Profile,
  candidate: Candidate,
  deps: VerdictDeps = {},
): Verdict {
  const now = deps.now ?? new Date();
  const inventory = deps.inventory ?? loadInventory();
  const ledger = deps.ledger ?? loadLedger();
  const protocols = deps.protocols ?? loadProtocols();
  const forecast = deps.forecast ?? [];

  const budget = budgetStatus(profile, candidate.priceUsd, ledger, now);
  const gateA = runGateA(profile, candidate, budget, inventory, now);
  const gateB = runGateB(profile, candidate, forecast);
  const gateC = runGateC(profile, candidate);
  const gates = [gateA, gateB, gateC];

  const missingData = requiredDataMissing(candidate);
  const anyViolation = gates.some((g) => !g.passed);

  // Violations are decisive even on thin data; approval requires enough
  // data for every gate to have actually evaluated something.
  let decision: Decision;
  if (anyViolation) decision = "REJECT";
  else if (missingData.length > 0) decision = "INSUFFICIENT_DATA";
  else decision = "APPROVE";

  const sizing = recommendSize(
    candidate.brand,
    candidate.category,
    `${candidate.name} ${candidate.descriptionText}`,
  );

  const committedProtocols = assignProtocols(
    [...candidate.materials, candidate.descriptionText],
    protocols,
  );
  const careCommitment = protocols
    .filter((p) => committedProtocols.includes(p.id))
    .map((p) => `${p.label} every ~${Math.round(p.intervalDays / 30)} months: ${p.directive}`);

  // Projected cost-per-wear from real wardrobe history: the same code-owned
  // projection DECIDE already uses, surfaced here so an APPROVE can show what
  // the piece would actually cost per wear against how the owner wears this
  // category. Pure code; the LLM never touches this number.
  const { median, sample } = medianCategoryWears(inventory, profile.id, candidate.category);
  const costProjection = {
    projectedCostPerWear:
      candidate.priceUsd !== null && median !== null
        ? costPerWear(candidate.priceUsd, median)
        : null,
    wearSample: sample,
    medianWears: median,
  };

  const verdict: Verdict = {
    id: newId("vrd"),
    at: now.toISOString(),
    profileId: profile.id,
    candidate,
    decision,
    missingData,
    gates,
    sizing,
    budget,
    careCommitment,
    costProjection,
  };

  if (deps.persist !== false) {
    appendJsonl("verdicts.jsonl", verdict);
  }
  return verdict;
}
