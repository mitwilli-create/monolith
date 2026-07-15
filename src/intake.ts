// The deep aspirational intake → a working Profile, by plain code.
// The answers are perception the OWNER supplied about themselves; this
// module is the single deterministic mapping from those answers to the
// hard fields gates read (biometrics, location, budget, material rules)
// and the soft aspiration block the transformer layers will read. No LLM
// anywhere in this path.

import type { Profile } from "./types.js";
import type { IntakeAnswers } from "./validate.js";

const lower = (s: string) => s.trim().toLowerCase();
const uniq = (xs: string[]) => [...new Set(xs.map(lower).filter(Boolean))];

export function intakeToProfile(a: IntakeAnswers, id: string, now: Date): Profile {
  const styleWords = uniq(a.yearOutStyleWords);
  const fabricHates = uniq(a.fabricHates);
  // A fabric named on both lists cannot be both a dealbreaker and a
  // preference; hates are dealbreakers, so hates win.
  const hated = new Set(fabricHates);
  const fabricLoves = uniq(a.fabricLoves).filter((m) => !hated.has(m));

  return {
    id,
    name: a.name.trim(),
    biometrics: {
      heightIn: a.heightIn,
      weightLb: a.weightLb,
      chestIn: a.chestIn,
      waistIn: a.waistIn,
      shoe: { us: a.shoeUs, width: a.shoeWidth.trim().toUpperCase() || "D" },
      thermal: a.thermal,
    },
    location: {
      city: a.location.city.trim(),
      region: a.location.region.trim(),
      zip: a.location.zip.trim(),
      lat: a.location.lat,
      lon: a.location.lon,
    },
    aesthetic: {
      // The doctrine opens as the user's own words: their year-out style
      // words become both the banner and the initial approved signals the
      // aesthetic axis scores against. They can refine all of it later.
      doctrine: styleWords.length ? styleWords.join(" · ") : "still forming",
      approvedSignals: styleWords,
      bannedAesthetics: [],
      bannedBrands: [],
      bannedFitTerms: [],
    },
    materialRules: {
      // Declared hates are dealbreakers the refusal enforces; declared
      // loves earn preferred-material notes. Both cite the intake so every
      // future verdict can say why in the owner's own terms.
      banned: fabricHates.map((m) => ({
        match: [m],
        reason: `you told MONOLITH at intake: no ${m}`,
      })),
      flagged: [],
      preferred: fabricLoves.map((m) => ({
        match: [m],
        reason: `a fabric you love (declared at intake)`,
      })),
    },
    budget: {
      monthlyUsd: a.monthlyBudgetUsd,
      hardStop: a.budgetHardStop,
    },
    aspiration: {
      demographics: a.demographics?.trim() || undefined,
      fabricLoves,
      fabricHates,
      labelsOwned: uniq(a.labelsOwned),
      changeMost: a.changeMost.trim(),
      yearOut: {
        wearing: a.yearOutWearing.trim(),
        styleWords,
        city: a.yearOutCity.trim(),
        identity: a.yearOutIdentity.trim(),
      },
      sweats: a.sweats,
      completedAt: now.toISOString(),
    },
    campaign: null,
  };
}
