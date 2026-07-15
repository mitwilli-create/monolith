import { describe, expect, it } from "vitest";
import {
  predictStack,
  recordFor,
  skipWear,
  upsertWear,
  type WearRecord,
} from "../src/wear.js";
import type { Item } from "../src/types.js";

function item(id: string, over: Partial<Item> = {}): Item {
  return {
    id, profileId: "m", category: "tops", brand: "B", name: id,
    materials: [], colors: [], wearCount: 0, careProtocolIds: [],
    ...over,
  };
}

function rec(date: string, itemIds: string[], over: Partial<WearRecord> = {}): WearRecord {
  return { id: `wear_${date}`, profileId: "m", date, itemIds, skipped: false, ...over };
}

const owned = new Set(["a", "b", "c", "d"]);

describe("upsertWear", () => {
  it("creates a day record and +1 deltas for every piece", () => {
    const { log, record, deltas } = upsertWear([], "m", "2026-07-14", ["a", "b"], owned);
    expect(log).toHaveLength(1);
    expect(record.itemIds).toEqual(["a", "b"]);
    expect(record.skipped).toBe(false);
    expect([...deltas.entries()].sort()).toEqual([["a", 1], ["b", 1]]);
  });

  it("re-logging the day adjusts counts by diff, not by re-adding", () => {
    const first = upsertWear([], "m", "2026-07-14", ["a", "b"], owned);
    const second = upsertWear(first.log, "m", "2026-07-14", ["b", "c"], owned);
    expect(second.log).toHaveLength(1); // still one record for the day
    expect(second.record.itemIds).toEqual(["b", "c"]);
    // a removed (-1), c added (+1), b untouched
    expect(second.deltas.get("a")).toBe(-1);
    expect(second.deltas.get("c")).toBe(1);
    expect(second.deltas.has("b")).toBe(false);
  });

  it("logging over a skip counts every piece fresh", () => {
    const skipped = skipWear([], "m", "2026-07-14");
    const logged = upsertWear(skipped.log, "m", "2026-07-14", ["a"], owned);
    expect(logged.record.skipped).toBe(false);
    expect(logged.deltas.get("a")).toBe(1);
  });

  it("dedupes ids and rejects pieces the profile does not own", () => {
    const { record } = upsertWear([], "m", "2026-07-14", ["a", "a", "b"], owned);
    expect(record.itemIds).toEqual(["a", "b"]);
    expect(() => upsertWear([], "m", "2026-07-14", ["ghost"], owned)).toThrow(/ghost/);
  });

  it("keeps days and profiles separate", () => {
    const day1 = upsertWear([], "m", "2026-07-13", ["a"], owned);
    const day2 = upsertWear(day1.log, "m", "2026-07-14", ["a"], owned);
    expect(day2.log).toHaveLength(2);
    expect(recordFor(day2.log, "m", "2026-07-13")!.itemIds).toEqual(["a"]);
    expect(recordFor(day2.log, "other", "2026-07-13")).toBeUndefined();
  });
});

describe("skipWear", () => {
  it("marks the day skipped without touching wear counts", () => {
    const { log, record } = skipWear([], "m", "2026-07-14");
    expect(record.skipped).toBe(true);
    expect(record.itemIds).toEqual([]);
    expect(log).toHaveLength(1);
  });

  it("never erases a real log for the same day", () => {
    const logged = upsertWear([], "m", "2026-07-14", ["a"], owned);
    const after = skipWear(logged.log, "m", "2026-07-14");
    expect(after.record.skipped).toBe(false);
    expect(after.record.itemIds).toEqual(["a"]);
  });
});

describe("predictStack", () => {
  const items = [
    item("a", { wearCount: 9 }),
    item("b", { wearCount: 1 }),
    item("c", { wearCount: 4 }),
    item("d", { wearCount: 0, acquiredAt: "2026-07-01" }),
  ];

  it("ranks by recency-weighted frequency from the owner's log", () => {
    const log = [
      rec("2026-07-13", ["b"]), // yesterday: strong signal
      rec("2026-07-01", ["a"]),
      rec("2026-06-30", ["a"]),
    ];
    const stack = predictStack(items, log, "m", "2026-07-14");
    expect(stack[0]!.id).toBe("b"); // 1/2 beats a's two old wears
    expect(stack.map((i) => i.id)).toContain("a");
  });

  it("cold-starts on wear counts, then newest acquisitions", () => {
    const stack = predictStack(items, [], "m", "2026-07-14");
    expect(stack.map((i) => i.id).slice(0, 2)).toEqual(["a", "c"]);
    expect(stack).toHaveLength(4); // min 3, max 6, capped by inventory
  });

  it("ignores skipped days, other profiles, and the future", () => {
    const log = [
      rec("2026-07-13", ["d"], { skipped: true }),
      rec("2026-07-13", ["d"], { profileId: "other", id: "wear_x" }),
      rec("2026-07-15", ["d"]), // tomorrow must not leak into today
    ];
    const stack = predictStack(items, log, "m", "2026-07-14");
    expect(stack[0]!.id).toBe("a"); // falls back to wear counts
  });

  it("caps at 6 and returns empty for an empty vault", () => {
    const many = Array.from({ length: 9 }, (_, i) => item(`i${i}`, { wearCount: i }));
    expect(predictStack(many, [], "m", "2026-07-14")).toHaveLength(6);
    expect(predictStack([], [], "m", "2026-07-14")).toEqual([]);
  });
});
