// GATE B: CLIMATE FILTER (the Seattle Filter, generalized per-profile).
// Material compatibility against the profile's climate rules, with a
// live-forecast advisory when rain-sensitive materials are in play.

import type {
  Candidate,
  GateFinding,
  GateResult,
  Profile,
  WeatherDay,
} from "../types.js";
import { materialRuleHit } from "../match.js";

function candidateText(c: Candidate): string {
  return [c.materials.join(" "), c.descriptionText, c.name]
    .join(" ")
    .toLowerCase();
}

export function runGateB(
  profile: Profile,
  candidate: Candidate,
  forecast: WeatherDay[] = [],
): GateResult {
  const violations: GateFinding[] = [];
  const notes: GateFinding[] = [];
  const text = candidateText(candidate);

  // Word-boundary + shell/lining aware (src/match.ts): "suede" no longer
  // fires on "microsuede", and a banned material found only in the LINING is
  // a note, not a rejection: the shell is what meets the rain.
  for (const rule of profile.materialRules.banned) {
    const hit = materialRuleHit(rule, candidate, text);
    if (!hit) continue;
    if (hit.where === "lining") {
      notes.push({
        code: "MATERIAL_BANNED_LINING",
        message: `"${hit.hit}" appears in the lining only. The shell is what meets the weather; noted, not rejected. (${rule.reason})`,
        source: "your material rules (banned, lining-scoped)",
      });
    } else {
      violations.push({
        code: "MATERIAL_BANNED",
        message: `"${hit.hit}": ${rule.reason}`,
        source: "your material rules (banned)",
      });
    }
  }

  for (const rule of profile.materialRules.flagged) {
    const hit = materialRuleHit(rule, candidate, text);
    if (hit) {
      notes.push({
        code: "MATERIAL_FLAGGED",
        message: `"${hit.hit}": ${rule.reason}`,
        source: "your material rules (advisory)",
      });
    }
  }

  for (const rule of profile.materialRules.preferred) {
    const hit = materialRuleHit(rule, candidate, text);
    if (hit && hit.where !== "lining") {
      notes.push({
        code: "MATERIAL_PREFERRED",
        message: `"${hit.hit}": ${rule.reason}`,
        source: "your material rules (preferred)",
      });
    }
  }

  // Live-forecast advisory: incoming sustained rain + a rain-tender material.
  const wetDays = forecast.filter(
    (d) => d.precipProb >= 70 || d.precipSumMm >= 8,
  );
  if (wetDays.length >= 2 && /leather|suede|nubuck/.test(text)) {
    notes.push({
      code: "FORECAST_ADVISORY",
      message: `${wetDays.length} heavy-precipitation days in the next ${forecast.length}-day window (${profile.location.city}). Leather/suede assets require protection on arrival.`,
      source: "live 7-day forecast",
    });
  }

  if (candidate.materials.length === 0) {
    notes.push({
      code: "MATERIALS_UNKNOWN",
      message:
        "No material composition extracted. Climate filter ran on description text only. Verify fabric before purchase.",
      source: "climate + materials check",
    });
  }

  return {
    gate: "B",
    name: "CLIMATE + MATERIALS",
    passed: violations.length === 0,
    violations,
    notes,
  };
}
