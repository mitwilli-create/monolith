// Regression pins for Qodo findings 2, 3, 4 (finding 1 → netguard.test.ts,
// finding 5 is a service-worker behavior verified in-browser).
import { describe, expect, it } from "vitest";
import { runGateC } from "../src/gates/gateC.js";
import { isIsoDate } from "../src/validate.js";
import { profile } from "./fixtures.js";
import type { Candidate } from "../src/types.js";

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    brand: "X", name: "Y", category: "tops", priceUsd: 100,
    materials: [], fitDescriptors: [], descriptionText: "", ...over,
  };
}

describe("Finding 4: Gate C collects every banned fit term", () => {
  it("reports multiple fit violations, no short-circuit", () => {
    const g = runGateC(profile, candidate({
      fitDescriptors: ["slim fit", "skinny fit"],
    }));
    const fitViolations = g.violations.filter((v) => v.code === "BANNED_FIT");
    expect(fitViolations.length).toBeGreaterThanOrEqual(2);
  });

  it("cites the profile chest measurement, not a hardcoded number", () => {
    const g = runGateC(profile, candidate({ fitDescriptors: ["slim fit"] }));
    const msg = g.violations.find((v) => v.code === "BANNED_FIT")!.message;
    expect(msg).toContain(`${profile.biometrics.chestIn}"`);
  });
});

describe("Finding 2 (backend half): isIsoDate gate", () => {
  it("accepts real ISO dates", () => {
    expect(isIsoDate("2026-07-06")).toBe(true);
    expect(isIsoDate("2000-01-01")).toBe(true);
  });
  it("rejects XSS payloads, malformed strings, and impossible dates", () => {
    for (const bad of [
      "</div><script>alert(1)</script>", "2026-7-6", "2026-13-01",
      "2026-02-30", "20260706", 20260706, null, undefined, "", "2026-07-06T12:00",
    ]) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });
});
