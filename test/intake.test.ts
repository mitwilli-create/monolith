// The deep aspirational intake: raw answers → Profile, by pure code.

import { describe, expect, it } from "vitest";
import { intakeToProfile } from "../src/intake.js";
import { IntakeSchema, ProfileSchema, type IntakeAnswers } from "../src/validate.js";

const NOW = new Date("2026-07-15T12:00:00Z");

function answers(over: Partial<IntakeAnswers> = {}): IntakeAnswers {
  return {
    name: "Test Stranger",
    demographics: "30s",
    location: { city: "Lisbon", region: "Lisboa", zip: "", lat: 38.72, lon: -9.14 },
    heightIn: 70,
    weightLb: 170,
    chestIn: 40,
    waistIn: 33,
    shoeUs: 10,
    shoeWidth: "d",
    thermal: "runs-hot",
    sweats: true,
    fabricLoves: ["Wool", "linen", "wool"],
    fabricHates: ["Polyester", "acrylic"],
    labelsOwned: ["Lemaire", "Our Legacy"],
    changeMost: "Stop buying graphic tees I never wear.",
    yearOutWearing: "A heavy wool overcoat over simple dark layers.",
    yearOutStyleWords: ["Minimal", "architectural", "minimal"],
    yearOutCity: "Copenhagen",
    yearOutIdentity: "Someone who owns thirty pieces and loves all of them.",
    monthlyBudgetUsd: 400,
    budgetHardStop: true,
    ...over,
  };
}

describe("intakeToProfile", () => {
  it("produces a profile that passes the full ProfileSchema", () => {
    const p = intakeToProfile(answers(), "usr_test01", NOW);
    const parsed = ProfileSchema.safeParse(p);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues[0])).toBe(true);
  });

  it("maps hard fields the gates read", () => {
    const p = intakeToProfile(answers(), "usr_test01", NOW);
    expect(p.biometrics.heightIn).toBe(70);
    expect(p.biometrics.shoe).toEqual({ us: 10, width: "D" });
    expect(p.biometrics.thermal).toBe("runs-hot");
    expect(p.location.lat).toBeCloseTo(38.72);
    expect(p.budget).toEqual({ monthlyUsd: 400, hardStop: true });
    expect(p.campaign).toBeNull();
  });

  it("declared fabric hates become banned material rules that cite the intake", () => {
    const p = intakeToProfile(answers(), "usr_test01", NOW);
    expect(p.materialRules.banned.map((r) => r.match)).toEqual([["polyester"], ["acrylic"]]);
    for (const rule of p.materialRules.banned) expect(rule.reason).toMatch(/intake/);
    expect(p.materialRules.preferred.map((r) => r.match)).toEqual([["wool"], ["linen"]]);
  });

  it("year-out style words become the opening doctrine and approved signals, deduped + lowercased", () => {
    const p = intakeToProfile(answers(), "usr_test01", NOW);
    expect(p.aesthetic.approvedSignals).toEqual(["minimal", "architectural"]);
    expect(p.aesthetic.doctrine).toBe("minimal · architectural");
  });

  it("keeps the aspirational answers verbatim for the soft layer", () => {
    const p = intakeToProfile(answers(), "usr_test01", NOW);
    expect(p.aspiration?.changeMost).toBe("Stop buying graphic tees I never wear.");
    expect(p.aspiration?.yearOut.city).toBe("Copenhagen");
    expect(p.aspiration?.sweats).toBe(true);
    expect(p.aspiration?.completedAt).toBe(NOW.toISOString());
  });

  it("empty style words fall back to an honest 'still forming' doctrine", () => {
    const p = intakeToProfile(answers({ yearOutStyleWords: ["  "] }), "usr_x", NOW);
    expect(p.aesthetic.doctrine).toBe("still forming");
    expect(p.aesthetic.approvedSignals).toEqual([]);
  });
});

describe("IntakeSchema", () => {
  it("accepts a full set of answers", () => {
    expect(IntakeSchema.safeParse(answers()).success).toBe(true);
  });

  it("rejects unknown keys and out-of-range numbers", () => {
    expect(IntakeSchema.safeParse({ ...answers(), extra: 1 }).success).toBe(false);
    expect(IntakeSchema.safeParse(answers({ heightIn: -3 })).success).toBe(false);
    expect(IntakeSchema.safeParse(answers({ monthlyBudgetUsd: 0 })).success).toBe(false);
  });

  it("rejects a location outside coordinate bounds", () => {
    const bad = answers();
    bad.location = { ...bad.location, lat: 91 };
    expect(IntakeSchema.safeParse(bad).success).toBe(false);
  });

  it("whitespace-only required answers are refusals to answer (CodeRabbit r1)", () => {
    expect(IntakeSchema.safeParse(answers({ name: "   " })).success).toBe(false);
    expect(IntakeSchema.safeParse(answers({ changeMost: "  " })).success).toBe(false);
    expect(IntakeSchema.safeParse(answers({ yearOutIdentity: "\n" })).success).toBe(false);
    expect(IntakeSchema.safeParse(answers({ yearOutStyleWords: [] })).success).toBe(false);
    const bad = answers();
    bad.location = { ...bad.location, city: "  " };
    expect(IntakeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("fabric loves/hates overlap (CodeRabbit r1)", () => {
  it("a fabric on both lists is a dealbreaker, never also a preference", () => {
    const p = intakeToProfile(
      answers({ fabricLoves: ["wool", "polyester"], fabricHates: ["polyester"] }),
      "usr_x",
      NOW,
    );
    expect(p.materialRules.banned.map((r) => r.match)).toEqual([["polyester"]]);
    expect(p.materialRules.preferred.map((r) => r.match)).toEqual([["wool"]]);
    expect(p.aspiration?.fabricLoves).toEqual(["wool"]);
  });
});
