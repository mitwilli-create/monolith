import { describe, expect, it } from "vitest";
import { runGateA } from "../src/gates/gateA.js";
import { runGateB } from "../src/gates/gateB.js";
import { runGateC } from "../src/gates/gateC.js";
import { runVerdict } from "../src/gates/engine.js";
import { budgetStatus } from "../src/budget.js";
import type { Candidate, Item, LedgerEntry, Profile } from "../src/types.js";
import { profile as seedProfile, protocols } from "./fixtures.js";

const NOW = new Date("2026-07-06T12:00:00Z");

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    brand: "Rick Owens",
    name: "Waxed cotton field jacket",
    category: "outerwear",
    priceUsd: 500,
    materials: ["waxed cotton"],
    fitDescriptors: ["oversized"],
    descriptionText: "Heavy waxed cotton field jacket with sculptural collar.",
    platform: "Farfetch",
    ...over,
  };
}

function profileWith(over: Partial<Profile> = {}): Profile {
  return JSON.parse(JSON.stringify({ ...seedProfile, ...over }));
}

function status(p: Profile, price: number | null, ledger: LedgerEntry[] = []) {
  return budgetStatus(p, price, ledger, NOW);
}

describe("Gate A: state audit", () => {
  it("passes a clean candidate with budget headroom", () => {
    const p = profileWith();
    const g = runGateA(p, candidate(), status(p, 500), [], NOW);
    expect(g.passed).toBe(true);
    expect(g.notes.some((n) => n.code === "BUDGET_CLEAR")).toBe(true);
  });

  it("rejects over-budget when hardStop is on", () => {
    const p = profileWith();
    const g = runGateA(p, candidate({ priceUsd: 5000 }), status(p, 5000), [], NOW);
    expect(g.passed).toBe(false);
    expect(g.violations[0]!.code).toBe("OVER_BUDGET");
  });

  it("downgrades over-budget to a note when hardStop is off", () => {
    const p = profileWith();
    p.budget.hardStop = false;
    const g = runGateA(p, candidate({ priceUsd: 5000 }), status(p, 5000), [], NOW);
    expect(g.passed).toBe(true);
    expect(g.notes.some((n) => n.code === "OVER_BUDGET")).toBe(true);
  });

  it("counts cleared same-month ledger spend against the budget", () => {
    const p = profileWith();
    const ledger: LedgerEntry[] = [
      { id: "1", profileId: p.id, date: "2026-07-02", description: "x", amountUsd: 400, cleared: true },
      { id: "2", profileId: p.id, date: "2026-07-03", description: "pending", amountUsd: 500, cleared: false },
      { id: "3", profileId: p.id, date: "2026-06-15", description: "last month", amountUsd: 900, cleared: true },
    ];
    const s = status(p, 300, ledger);
    expect(s.spentUsd).toBe(400);
    expect(s.remainingUsd).toBe(200);
    const g = runGateA(p, candidate({ priceUsd: 300 }), s, [], NOW);
    expect(g.violations[0]!.code).toBe("OVER_BUDGET");
  });

  it("notes unknown price instead of rejecting", () => {
    const p = profileWith();
    const g = runGateA(p, candidate({ priceUsd: null }), status(p, null), [], NOW);
    expect(g.passed).toBe(true);
    expect(g.notes.some((n) => n.code === "PRICE_UNKNOWN")).toBe(true);
  });

  it("detects an inventory clash on brand+category+name overlap", () => {
    const p = profileWith();
    const owned: Item[] = [{
      id: "i1", profileId: p.id, category: "outerwear", brand: "Rick Owens",
      name: "Field jacket waxed", materials: ["waxed cotton"], colors: [],
      wearCount: 3, careProtocolIds: [],
    }];
    const g = runGateA(p, candidate(), status(p, 500), owned, NOW);
    expect(g.violations.some((v) => v.code === "INVENTORY_CLASH")).toBe(true);
  });

  it("enforces campaign dormancy and platform lock when a campaign is active", () => {
    const p = profileWith({
      campaign: {
        platform: "Farfetch", targetUsd: 12000, deadline: "2027-05-01",
        clearedUsd: 3380, dormantMonths: [7], pushMonths: [2, 3], promoNotes: "",
      },
    });
    // July is dormant in this fixture
    const g = runGateA(p, candidate({ platform: "SSENSE" }), status(p, 500), [], NOW);
    const codes = g.violations.map((v) => v.code);
    expect(codes).toContain("DORMANCY");
    expect(codes).toContain("OFF_PLATFORM");
  });
});

describe("Gate B: climate filter", () => {
  const p = profileWith();

  it("rejects untreated suede", () => {
    const g = runGateB(p, candidate({
      name: "Suede chelsea boot",
      materials: ["suede"],
      descriptionText: "suede chelsea boot",
    }));
    expect(g.passed).toBe(false);
    expect(g.violations[0]!.code).toBe("MATERIAL_BANNED");
  });

  it("allows treated suede via the unless clause", () => {
    const g = runGateB(p, candidate({
      materials: ["treated suede"],
      descriptionText: "waterproof treated suede boot",
    }));
    expect(g.passed).toBe(true);
  });

  it("flags non-breathable synthetics as a note, not a violation", () => {
    const g = runGateB(p, candidate({ materials: ["100% polyester"], descriptionText: "" }));
    expect(g.passed).toBe(true);
    expect(g.notes.some((n) => n.code === "MATERIAL_FLAGGED")).toBe(true);
  });

  it("credits preferred materials", () => {
    const g = runGateB(p, candidate());
    expect(g.notes.some((n) => n.code === "MATERIAL_PREFERRED")).toBe(true);
  });

  it("adds a forecast advisory for leather when heavy rain is incoming", () => {
    const wet = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-07-0${i + 7}`, tMaxF: 60, tMinF: 50, precipProb: 85, precipSumMm: 12,
    }));
    const g = runGateB(p, candidate({ materials: ["calfskin leather"], descriptionText: "leather jacket" }), wet);
    expect(g.notes.some((n) => n.code === "FORECAST_ADVISORY")).toBe(true);
  });

  it("notes when no materials were extracted", () => {
    const g = runGateB(p, candidate({ materials: [], descriptionText: "a jacket" }));
    expect(g.notes.some((n) => n.code === "MATERIALS_UNKNOWN")).toBe(true);
  });
});

describe("Gate C: aesthetic gate", () => {
  const p = profileWith();

  it("rejects banned brands", () => {
    const g = runGateC(p, candidate({ brand: "Ader Error" }));
    expect(g.violations.some((v) => v.code === "BANNED_BRAND")).toBe(true);
  });

  it("rejects slim fit designations anywhere in the text", () => {
    const g = runGateC(p, candidate({ fitDescriptors: ["slim fit"] }));
    expect(g.violations.some((v) => v.code === "BANNED_FIT")).toBe(true);
  });

  it("rejects basic-office markers", () => {
    const g = runGateC(p, candidate({
      name: "Stretch chino trouser",
      descriptionText: "business casual chino for the office",
    }));
    expect(g.violations.some((v) => v.code === "AESTHETIC_BREACH")).toBe(true);
  });

  it("credits doctrine signals", () => {
    const g = runGateC(p, candidate({ descriptionText: "object-dyed sculptural asymmetric shirt" }));
    expect(g.passed).toBe(true);
    expect(g.notes.some((n) => n.code === "DOCTRINE_ALIGNED")).toBe(true);
  });
});

describe("Verdict engine", () => {
  const deps = { inventory: [], ledger: [], protocols, forecast: [], now: NOW, persist: false as const };

  it("APPROVES a doctrine-aligned, in-budget candidate", () => {
    const v = runVerdict(profileWith(), candidate(), deps);
    expect(v.decision).toBe("APPROVE");
    expect(v.gates).toHaveLength(3);
    expect(v.sizing.recommendation.length).toBeGreaterThan(0);
  });

  it("REJECTS on any single gate violation", () => {
    const v = runVerdict(profileWith(), candidate({ fitDescriptors: ["slim fit"] }), deps);
    expect(v.decision).toBe("REJECT");
  });

  it("returns INSUFFICIENT_DATA instead of approving on thin data", () => {
    const v = runVerdict(profileWith(), candidate({ materials: [], descriptionText: "" }), deps);
    expect(v.decision).toBe("INSUFFICIENT_DATA");
    expect(v.missingData.length).toBeGreaterThan(0);
  });

  it("violations still REJECT even when data is thin (no sycophancy escape hatch)", () => {
    const v = runVerdict(
      profileWith(),
      candidate({ brand: "Ader Error", materials: [], descriptionText: "" }),
      deps,
    );
    expect(v.decision).toBe("REJECT");
  });

  it("attaches care commitments derived from candidate materials", () => {
    const v = runVerdict(profileWith(), candidate(), deps);
    expect(v.careCommitment.some((c) => c.toLowerCase().includes("re-wax"))).toBe(true);
  });
});
