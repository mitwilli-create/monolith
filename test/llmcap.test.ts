// Per-user daily LLM spend cap (multi-user mode only). Env staged before
// import so config.ts reports MULTIUSER; per-file process isolation keeps
// it contained.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.MONOLITH_FAKE_AUTH = "1";
process.env.MONOLITH_LLM_DAILY_CAP = "5";

let spendLlm: typeof import("../src/llmcap.js").spendLlm;

beforeAll(async () => {
  ({ spendLlm } = await import("../src/llmcap.js"));
});

afterAll(() => {
  delete process.env.MONOLITH_FAKE_AUTH;
  delete process.env.MONOLITH_LLM_DAILY_CAP;
});

describe("spendLlm", () => {
  it("allows until the daily cap, then refuses without charging", () => {
    const day = "2026-07-15";
    expect(spendLlm("u1", 3, day)).toEqual({ allowed: true, remaining: 2 });
    expect(spendLlm("u1", 2, day)).toEqual({ allowed: true, remaining: 0 });
    expect(spendLlm("u1", 1, day)).toEqual({ allowed: false, remaining: 0 });
    // The refused call must not have burned anything: a new day is fresh.
    expect(spendLlm("u1", 5, "2026-07-16").allowed).toBe(true);
  });

  it("a cost larger than what remains is refused but smaller ones still fit", () => {
    const day = "2026-07-15";
    expect(spendLlm("u2", 4, day).allowed).toBe(true);
    expect(spendLlm("u2", 2, day).allowed).toBe(false);
    expect(spendLlm("u2", 1, day).allowed).toBe(true);
  });

  it("users are metered independently", () => {
    const day = "2026-07-15";
    expect(spendLlm("u3", 5, day).allowed).toBe(true);
    expect(spendLlm("u4", 5, day).allowed).toBe(true);
  });

  it("day rollover resets the meter", () => {
    expect(spendLlm("u5", 5, "2026-07-15").allowed).toBe(true);
    expect(spendLlm("u5", 5, "2026-07-16").allowed).toBe(true);
  });

  it("rejects negative, NaN, and infinite costs outright (CodeRabbit r1)", () => {
    expect(() => spendLlm("u6", -1, "2026-07-15")).toThrow(RangeError);
    expect(() => spendLlm("u6", Number.NaN, "2026-07-15")).toThrow(RangeError);
    expect(() => spendLlm("u6", Number.POSITIVE_INFINITY, "2026-07-15")).toThrow(RangeError);
  });
});
