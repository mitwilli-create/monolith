// PUT /api/profile validation (Qodo r2 finding 1): the stored-XSS root fix.
import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/validate.js";
import { profile as seedProfile } from "./fixtures.js";

function clone(): any {
  return JSON.parse(JSON.stringify(seedProfile));
}

describe("ProfileSchema", () => {
  it("accepts the seed profile verbatim", () => {
    const r = ProfileSchema.safeParse(seedProfile);
    expect(r.success).toBe(true);
  });

  it("rejects markup smuggled into a numeric field", () => {
    const p = clone();
    p.biometrics.chestIn = `"><img src=x onerror=alert(1)>`;
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects a string where the budget number belongs", () => {
    const p = clone();
    p.budget.monthlyUsd = "1000\" onfocus=\"alert(1)";
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const p = clone();
    p.__proto__polluter = { evil: true };
    p.extraField = "nope";
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects an id with markup-capable characters", () => {
    const p = clone();
    p.id = "<script>alert(1)</script>";
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects an invalid thermal enum", () => {
    const p = clone();
    p.biometrics.thermal = "onfire";
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });

  it("accepts a numeric measurement block and rejects non-numeric values", () => {
    const p = clone();
    p.biometrics.measurements = {
      source: "test sheet",
      measuredAt: "2026-06-16",
      unit: "in",
      values: { waist: 45.5 },
    };
    expect(ProfileSchema.safeParse(p).success).toBe(true);
    p.biometrics.measurements.values["waist"] = "<b>45</b>";
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects impossible calendar dates in measuredAt and campaign.deadline", () => {
    const p = clone();
    p.biometrics.measurements = {
      source: "test sheet",
      measuredAt: "2026-02-31",
      unit: "in",
      values: { waist: 45.5 },
    };
    expect(ProfileSchema.safeParse(p).success).toBe(false);

    const q = clone();
    q.campaign = {
      platform: "Farfetch", targetUsd: 12000, deadline: "2026-02-31",
      clearedUsd: 0, dormantMonths: [], pushMonths: [], promoNotes: "",
    };
    expect(ProfileSchema.safeParse(q).success).toBe(false);
  });

  it("accepts a valid campaign and rejects a malformed one", () => {
    const p = clone();
    p.campaign = {
      platform: "Farfetch", targetUsd: 12000, deadline: "2027-05-01",
      clearedUsd: 3380, dormantMonths: [12, 1], pushMonths: [2, 3], promoNotes: "",
    };
    expect(ProfileSchema.safeParse(p).success).toBe(true);
    p.campaign.dormantMonths = [13];
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });
});
