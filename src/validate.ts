import { z } from "zod";

/** Strict YYYY-MM-DD gate for persisted dates (Qodo finding 2, backend half). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const isoDate = z
  .string()
  .refine((s) => isIsoDate(s), { message: "must be a valid YYYY-MM-DD calendar date" });

const materialRule = z
  .object({
    match: z.array(z.string().max(100)).min(1),
    unless: z.array(z.string().max(100)).optional(),
    reason: z.string().max(500),
  })
  .strict();

/**
 * Runtime schema for POST /api/quests. Same discipline as the profile:
 * bounded strings, numbers that are numbers, no unknown keys. The
 * stretch >= target invariant is enforced here so the love-band math in
 * quests.ts never sees an inverted band.
 */
export const QuestCreateSchema = z
  .object({
    title: z.string().min(1).max(120),
    category: z.enum(["outerwear", "tops", "bottoms", "footwear", "accessories"]),
    mustHaves: z.array(z.string().min(1).max(100)).max(30),
    niceToHaves: z.array(z.string().min(1).max(100)).max(30),
    mustNotHaves: z.array(z.string().min(1).max(100)).max(30).optional(),
    targetUsd: z.number().positive().max(1_000_000),
    stretchUsd: z.number().positive().max(1_000_000),
    deadline: isoDate.optional(),
  })
  .strict()
  .refine((q) => q.stretchUsd >= q.targetUsd, {
    message: "stretchUsd must be >= targetUsd",
  });

/**
 * Runtime schema for PUT /api/quests/:id. All fields optional; category is
 * deliberately not editable (candidate scores and wear projections are
 * category-scoped). The stretch >= target invariant is checked post-merge in
 * the route, where both effective values are known.
 */
export const QuestEditSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    mustHaves: z.array(z.string().min(1).max(100)).max(30).optional(),
    niceToHaves: z.array(z.string().min(1).max(100)).max(30).optional(),
    mustNotHaves: z.array(z.string().min(1).max(100)).max(30).optional(),
    targetUsd: z.number().positive().max(1_000_000).optional(),
    stretchUsd: z.number().positive().max(1_000_000).optional(),
    /** empty string clears the deadline */
    deadline: z.union([isoDate, z.literal("")]).optional(),
  })
  .strict();

/**
 * Runtime schema for PUT /api/profile (Qodo r2 finding 1, stored XSS root).
 * Numbers must be numbers, enums must be enums, unknown keys are rejected;
 * a profile that validates here cannot smuggle markup into numeric fields,
 * and every string field is bounded.
 */
/**
 * Runtime schema for POST /api/intake: the deep aspirational onboarding.
 * Raw answers, not a Profile — intakeToProfile() (pure code) builds the
 * Profile from these, so the mapping from answers to gates/doctrine is
 * deterministic and unit-testable.
 */
export const IntakeSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    demographics: z.string().max(300).optional(),
    location: z
      .object({
        city: z.string().trim().min(1).max(100),
        region: z.string().max(50),
        zip: z.string().max(20),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      })
      .strict(),
    heightIn: z.number().positive().max(120),
    weightLb: z.number().positive().max(1500),
    chestIn: z.number().positive().max(120),
    waistIn: z.number().positive().max(120),
    shoeUs: z.number().positive().max(30),
    shoeWidth: z.string().max(4),
    thermal: z.enum(["runs-hot", "neutral", "runs-cold"]),
    sweats: z.boolean().optional(),
    fabricLoves: z.array(z.string().min(1).max(60)).max(40),
    fabricHates: z.array(z.string().min(1).max(60)).max(40),
    labelsOwned: z.array(z.string().min(1).max(80)).max(60),
    // The aspirational core is required in substance, not just in shape:
    // whitespace-only answers are refusals to answer, and the wizard
    // enforces the same floor client-side.
    changeMost: z.string().trim().min(1).max(2000),
    yearOutWearing: z.string().trim().min(1).max(2000),
    yearOutStyleWords: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
    // Deliberately optional, unlike its neighbors: the projective anchor
    // works without naming a city, and the UI renders the absence as
    // "your own streets". Not an oversight.
    yearOutCity: z.string().max(120),
    yearOutIdentity: z.string().trim().min(1).max(2000),
    monthlyBudgetUsd: z.number().positive().max(10_000_000),
    budgetHardStop: z.boolean(),
  })
  .strict();

export type IntakeAnswers = z.infer<typeof IntakeSchema>;

export const ProfileSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, "id: letters, digits, - and _ only"),
    name: z.string().min(1).max(100),
    biometrics: z
      .object({
        heightIn: z.number().positive().max(120),
        weightLb: z.number().positive().max(1500),
        chestIn: z.number().positive().max(120),
        bustIn: z.number().positive().max(120).optional(),
        waistIn: z.number().positive().max(120),
        tagPantWaistIn: z.number().positive().max(120).optional(),
        shoe: z.object({ us: z.number().positive().max(30), width: z.string().max(4) }).strict(),
        thermal: z.enum(["runs-hot", "neutral", "runs-cold"]),
        measurements: z
          .object({
            source: z.string().max(200),
            measuredAt: isoDate,
            unit: z.literal("in"),
            values: z.record(z.string().max(60), z.number().min(0).max(500)),
            toConfirm: z.array(z.string().max(60)).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    location: z
      .object({
        city: z.string().max(100),
        region: z.string().max(50),
        zip: z.string().max(20),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      })
      .strict(),
    aesthetic: z
      .object({
        doctrine: z.string().max(200),
        approvedSignals: z.array(z.string().max(100)).max(200),
        bannedAesthetics: z
          .array(
            z
              .object({
                key: z.string().max(50),
                label: z.string().max(100),
                markers: z.array(z.string().max(100)).max(200),
              })
              .strict(),
          )
          .max(50),
        bannedBrands: z.array(z.string().max(100)).max(200),
        bannedFitTerms: z.array(z.string().max(100)).max(200),
      })
      .strict(),
    materialRules: z
      .object({
        banned: z.array(materialRule).max(100),
        flagged: z.array(materialRule).max(100),
        preferred: z.array(materialRule).max(100),
      })
      .strict(),
    aspiration: z
      .object({
        demographics: z.string().max(300).optional(),
        fabricLoves: z.array(z.string().min(1).max(60)).max(40),
        fabricHates: z.array(z.string().min(1).max(60)).max(40),
        labelsOwned: z.array(z.string().min(1).max(80)).max(60),
        changeMost: z.string().max(2000),
        yearOut: z
          .object({
            wearing: z.string().max(2000),
            styleWords: z.array(z.string().min(1).max(40)).max(10),
            city: z.string().max(120),
            identity: z.string().max(2000),
          })
          .strict(),
        sweats: z.boolean().optional(),
        completedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
    budget: z
      .object({
        monthlyUsd: z.number().positive().max(10_000_000),
        hardStop: z.boolean(),
      })
      .strict(),
    campaign: z.union([
      z.null(),
      z
        .object({
          platform: z.string().max(100),
          targetUsd: z.number().positive().max(100_000_000),
          deadline: isoDate,
          clearedUsd: z.number().min(0).max(100_000_000),
          dormantMonths: z.array(z.number().int().min(1).max(12)).max(12),
          pushMonths: z.array(z.number().int().min(1).max(12)).max(12),
          promoNotes: z.string().max(1000),
        })
        .strict(),
    ]),
  })
  .strict();
