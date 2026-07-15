// The sizing matrix must answer exactly per the gem doc for all three seeded brands.
import { describe, expect, it } from "vitest";
import { recommendSize } from "../src/sizing.js";
import { sizingMatrix } from "./fixtures.js";

const m = sizingMatrix;

describe("Sizing matrix: Boris Bidjan Saberi", () => {
  it("tops: size up 1-2 grades", () => {
    const r = recommendSize("Boris Bidjan Saberi", "tops", "object dyed shirt", m);
    expect(r.fallback).toBe(false);
    expect(r.recommendation).toMatch(/1–2 full grades/);
  });

  it("coated denim bottoms: mandatory upsize", () => {
    const r = recommendSize("Boris Bidjan Saberi", "bottoms", "P13 coated denim", m);
    expect(r.recommendation).toMatch(/Mandatory upsize/);
  });

  it("generic bottoms fall to the brand-general rule", () => {
    const r = recommendSize("Boris Bidjan Saberi", "bottoms", "wool trouser", m);
    expect(r.fallback).toBe(false);
    expect(r.recommendation).toMatch(/at least 1 grade/);
  });
});

describe("Sizing matrix: Rick Owens", () => {
  it("leather outerwear: IT 54 mandatory", () => {
    const r = recommendSize("Rick Owens", "outerwear", "intarsia leather jacket", m);
    expect(r.recommendation).toMatch(/IT 54 mandatory/);
  });

  it("creatch cargo: size DOWN despite the 36-inch waist", () => {
    const r = recommendSize("Rick Owens", "bottoms", "DRKSHDW creatch cargo pants", m);
    expect(r.recommendation).toMatch(/Size DOWN/);
  });

  it("ramones: down 0.5-1 size", () => {
    const r = recommendSize("Rick Owens", "footwear", "mainline Ramones high top", m);
    expect(r.recommendation).toMatch(/0\.5–1 full size/);
  });

  it("sock sneakers: down up to 2 sizes", () => {
    const r = recommendSize("Rick Owens", "footwear", "sock runner", m);
    expect(r.recommendation).toMatch(/2 full sizes/);
  });
});

describe("Sizing matrix: Maison Margiela", () => {
  it("tops: IT 54 minimum", () => {
    const r = recommendSize("Maison Margiela", "tops", "knit sweater", m);
    expect(r.recommendation).toMatch(/IT 54 minimum/);
  });
});

describe("Fallback", () => {
  it("unknown brands get the biometric baseline with its source cited", () => {
    const r = recommendSize("Some Unknown Label", "tops", "shirt", m);
    expect(r.fallback).toBe(true);
    expect(r.recommendation).toMatch(/XL/);
    expect(r.source).toMatch(/biometric/i);
  });

  it("brand matching is case-insensitive and tolerant of partials", () => {
    const r = recommendSize("rick owens drkshdw", "bottoms", "creatch", m);
    expect(r.fallback).toBe(false);
  });
});
