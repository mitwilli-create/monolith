// Care & laundry engine: protocol schedules per item, care log,
// and weather-triggered protection alerts.

import type {
  CareLogEntry,
  CareProtocol,
  CareTask,
  Item,
  WeatherAlert,
  WeatherDay,
} from "./types.js";
import { newId, readJson, writeJson } from "./store.js";

const PROTOCOLS_FILE = "care-protocols.json";
const LOG_FILE = "care-log.json";

export function loadProtocols(): CareProtocol[] {
  return readJson<{ protocols: CareProtocol[] }>(PROTOCOLS_FILE, {
    protocols: [],
  }).protocols;
}

export function loadCareLog(): CareLogEntry[] {
  return readJson<CareLogEntry[]>(LOG_FILE, []);
}

export function logCare(
  entry: Omit<CareLogEntry, "id">,
): CareLogEntry {
  const full: CareLogEntry = { ...entry, id: newId("care") };
  const log = loadCareLog();
  log.push(full);
  writeJson(LOG_FILE, log);
  return full;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute due care tasks. For each (item, protocol), the clock starts at the
 * latest care-log entry, else the item's acquisition date, else `graceStart`
 * (defaults to now, so newly imported undated items don't wake up 100% overdue).
 */
export function dueTasks(
  items: Item[],
  protocols: CareProtocol[],
  log: CareLogEntry[],
  now: Date = new Date(),
  graceStart?: Date,
): CareTask[] {
  const byId = new Map(protocols.map((p) => [p.id, p]));
  const tasks: CareTask[] = [];
  for (const item of items) {
    for (const pid of item.careProtocolIds) {
      const proto = byId.get(pid);
      if (!proto) continue;
      const lastLog = log
        .filter((l) => l.itemId === item.id && l.protocolId === pid)
        .map((l) => new Date(l.date).getTime())
        .sort((a, b) => b - a)[0];
      const acquired = item.acquiredAt
        ? new Date(item.acquiredAt).getTime()
        : undefined;
      const anchor = lastLog ?? acquired ?? (graceStart ?? now).getTime();
      const anchorSource: CareTask["anchorSource"] =
        lastLog !== undefined ? "care-log" : acquired !== undefined ? "acquired" : "first-seen";
      const dueAt = anchor + proto.intervalDays * DAY_MS;
      if (dueAt <= now.getTime()) {
        tasks.push({
          itemId: item.id,
          itemLabel: `${item.brand}, ${item.name}`,
          protocolId: proto.id,
          protocolLabel: proto.label,
          directive: proto.directive,
          dueSince: new Date(dueAt).toISOString().slice(0, 10),
          overdueDays: Math.floor((now.getTime() - dueAt) / DAY_MS),
          intervalDays: proto.intervalDays,
          anchorSource,
          anchorDate: new Date(anchor).toISOString().slice(0, 10),
        });
      }
    }
  }
  return tasks.sort((a, b) => b.overdueDays - a.overdueDays);
}

/**
 * Weather-triggered protection alerts: sustained/heavy precipitation ahead +
 * owned items on rain-sensitive protocols.
 */
export function weatherAlerts(
  items: Item[],
  protocols: CareProtocol[],
  forecast: WeatherDay[],
): WeatherAlert[] {
  const alerts: WeatherAlert[] = [];
  const rainProtocols = protocols.filter((p) => p.rainSensitive);
  const heavy = forecast.filter((d) => d.precipProb >= 70 || d.precipSumMm >= 8);
  if (heavy.length === 0 || rainProtocols.length === 0) return alerts;

  const rainIds = new Set(rainProtocols.map((p) => p.id));
  const atRisk = items
    .filter((i) => i.careProtocolIds.some((pid) => rainIds.has(pid)))
    .map((i) => {
      const proto = rainProtocols.find((p) => i.careProtocolIds.includes(p.id))!;
      return {
        itemId: i.id,
        itemLabel: `${i.brand}, ${i.name}`,
        directive: proto.directive,
      };
    });

  if (atRisk.length > 0) {
    const days = heavy.map((d) => d.date.slice(5)).join(", ");
    alerts.push({
      severity: heavy.length >= 3 ? "warn" : "info",
      message: `Heavy precipitation incoming (${days}). ${atRisk.length} rain-sensitive asset${atRisk.length === 1 ? "" : "s"} require protection or bench rotation.`,
      itemsAtRisk: atRisk,
    });
  }
  return alerts;
}
