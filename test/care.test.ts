import { describe, expect, it } from "vitest";
import { dueTasks, weatherAlerts } from "../src/care.js";
import { assignProtocols } from "../src/inventory.js";
import { costPerWear } from "../src/budget.js";
import type { Item, WeatherDay } from "../src/types.js";
import { protocols } from "./fixtures.js";

const NOW = new Date("2026-07-06T12:00:00Z");

function item(over: Partial<Item> = {}): Item {
  return {
    id: "i1", profileId: "mitchell", category: "outerwear",
    brand: "Barbour", name: "Waxed Bedale",
    materials: ["waxed cotton"], colors: ["olive"],
    acquiredAt: "2025-01-01", wearCount: 40,
    careProtocolIds: assignProtocols(["waxed cotton"], protocols),
    ...over,
  };
}

describe("Care protocol assignment", () => {
  it("assigns re-wax to waxed cotton", () => {
    expect(assignProtocols(["waxed cotton"], protocols)).toContain("rewax");
  });
  it("assigns leather conditioning to calfskin", () => {
    expect(assignProtocols(["calfskin leather"], protocols)).toContain("leather-condition");
  });
  it("assigns nothing for unknown materials", () => {
    expect(assignProtocols(["unobtainium"], protocols)).toHaveLength(0);
  });
});

describe("Due-task scheduling", () => {
  it("surfaces a task when the interval has elapsed since acquisition", () => {
    const tasks = dueTasks([item()], protocols, [], NOW);
    expect(tasks.some((t) => t.protocolId === "rewax")).toBe(true);
    expect(tasks[0]!.overdueDays).toBeGreaterThan(0);
  });

  it("resets the clock from the latest care-log entry", () => {
    const tasks = dueTasks(
      [item()],
      protocols,
      [{ id: "c1", profileId: "mitchell", itemId: "i1", protocolId: "rewax", date: "2026-06-01" }],
      NOW,
    );
    expect(tasks.some((t) => t.protocolId === "rewax")).toBe(false);
  });

  it("undated items start their clock at graceStart, not the epoch", () => {
    const tasks = dueTasks([item({ acquiredAt: undefined })], protocols, [], NOW, NOW);
    expect(tasks).toHaveLength(0);
  });
});

describe("Weather alerts", () => {
  const wet: WeatherDay[] = Array.from({ length: 4 }, (_, i) => ({
    date: `2026-07-0${i + 6}`, tMaxF: 58, tMinF: 48, precipProb: 90, precipSumMm: 15,
  }));
  const dry: WeatherDay[] = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-07-0${i + 1}`, tMaxF: 77, tMinF: 55, precipProb: 5, precipSumMm: 0,
  }));

  it("alerts on heavy rain when rain-sensitive assets are owned", () => {
    const leather = item({ id: "i2", materials: ["leather"], careProtocolIds: assignProtocols(["leather"], protocols) });
    const alerts = weatherAlerts([leather], protocols, wet);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("warn");
    expect(alerts[0]!.itemsAtRisk[0]!.itemLabel).toContain("Barbour");
  });

  it("stays silent in dry weather", () => {
    const leather = item({ id: "i2", materials: ["leather"], careProtocolIds: assignProtocols(["leather"], protocols) });
    expect(weatherAlerts([leather], protocols, dry)).toHaveLength(0);
  });

  it("stays silent when nothing owned is rain-sensitive", () => {
    const wool = item({ id: "i3", materials: ["wool"], careProtocolIds: assignProtocols(["wool"], protocols) });
    expect(weatherAlerts([wool], protocols, wet)).toHaveLength(0);
  });
});

describe("Cost per wear", () => {
  it("divides price by wear count", () => {
    expect(costPerWear(400, 40)).toBe(10);
  });
  it("returns null while unworn: no phantom $/wear on a never-worn piece", () => {
    expect(costPerWear(400, 0)).toBeNull();
  });
  it("returns null with no price", () => {
    expect(costPerWear(undefined, 10)).toBeNull();
  });
});
