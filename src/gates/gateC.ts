// GATE C: AESTHETIC GATE.
// Doctrine integrity: banned brands, banned fit terms, banned aesthetic
// markers, and positive doctrine signals.

import type {
  Candidate,
  GateFinding,
  GateResult,
  Profile,
} from "../types.js";

export function runGateC(profile: Profile, candidate: Candidate): GateResult {
  const violations: GateFinding[] = [];
  const notes: GateFinding[] = [];
  const a = profile.aesthetic;
  const text = [
    candidate.brand,
    candidate.name,
    candidate.descriptionText,
    candidate.fitDescriptors.join(" "),
  ]
    .join(" ")
    .toLowerCase();

  for (const brand of a.bannedBrands) {
    if (candidate.brand.toLowerCase().includes(brand.toLowerCase())) {
      violations.push({
        code: "BANNED_BRAND",
        message: `${brand} is on the banned-brand register. No exceptions.`,
        source: "your banned-brand register",
      });
    }
  }

  // Collect every banned fit term, no short-circuit (Qodo finding 4;
  // matches the README's report-every-violation contract).
  const fitHits = a.bannedFitTerms.filter((term) =>
    text.includes(term.toLowerCase()),
  );
  for (const term of fitHits) {
    violations.push({
      code: "BANNED_FIT",
      message: `"${term}" designation: automatic rejection against a ${profile.biometrics.chestIn}" chest. The cut does not exist in a wearable grade.`,
      source: "your banned fit terms",
    });
  }

  for (const banned of a.bannedAesthetics) {
    const marker = banned.markers.find((m) => text.includes(m.toLowerCase()));
    if (marker) {
      violations.push({
        code: "AESTHETIC_BREACH",
        message: `${banned.label} marker ("${marker}"): incompatible with the ${a.doctrine} doctrine.`,
        source: `your aesthetic doctrine (${banned.label})`,
      });
    }
  }

  const signals = a.approvedSignals.filter((s) =>
    text.includes(s.toLowerCase()),
  );
  if (signals.length > 0) {
    notes.push({
      code: "DOCTRINE_ALIGNED",
      message: `Doctrine signals present: ${signals.join(", ")}.`,
      source: "your doctrine signals",
    });
  }

  return {
    gate: "C",
    name: "AESTHETIC DOCTRINE",
    passed: violations.length === 0,
    violations,
    notes,
  };
}
