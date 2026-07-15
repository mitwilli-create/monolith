// Domain types for THE MONOLITH.
// Everything a gate needs to reach a verdict is data: profiles, rules,
// sizing matrices. No constraint lives in a prompt.

export type Category =
  | "outerwear"
  | "tops"
  | "bottoms"
  | "footwear"
  | "accessories";

export const CATEGORIES: Category[] = [
  "outerwear",
  "tops",
  "bottoms",
  "footwear",
  "accessories",
];

export interface MaterialRule {
  /** lowercase substrings matched against materials + description */
  match: string[];
  /** if any of these appear alongside a match, the rule does not fire (e.g. "treated" suede) */
  unless?: string[];
  reason: string;
}

export interface BannedAesthetic {
  key: string;
  label: string;
  /** lowercase markers matched against brand + name + description */
  markers: string[];
}

export interface Profile {
  id: string;
  name: string;
  biometrics: {
    heightIn: number;
    weightLb: number;
    /** measured chest (tailoring) */
    chestIn: number;
    bustIn?: number;
    /** measured tailoring waist (at navel) */
    waistIn: number;
    /** trouser/denim tag size: what sizing charts mean by "waist" */
    tagPantWaistIn?: number;
    shoe: { us: number; width: string };
    thermal: "runs-hot" | "neutral" | "runs-cold";
    /** full measurement specification (e.g. a tailor's sheet) */
    measurements?: {
      source: string;
      measuredAt: string; // YYYY-MM-DD
      unit: "in";
      values: Record<string, number>;
      toConfirm?: string[];
    };
  };
  location: {
    city: string;
    region: string;
    zip: string;
    lat: number;
    lon: number;
  };
  aesthetic: {
    doctrine: string;
    approvedSignals: string[];
    bannedAesthetics: BannedAesthetic[];
    bannedBrands: string[];
    bannedFitTerms: string[];
  };
  materialRules: {
    banned: MaterialRule[];
    flagged: MaterialRule[];
    preferred: MaterialRule[];
  };
  budget: {
    monthlyUsd: number;
    /** true = over-budget is a violation; false = advisory note only */
    hardStop: boolean;
  };
  /**
   * The deep aspirational intake (Sprint B): who this person is becoming.
   * Soft-layer data only — it feeds doctrine, signals, and (Sprint C) the
   * transformation dial. It can NEVER touch a gate; gates read the hard
   * fields above. Optional so pre-intake profiles stay valid.
   */
  aspiration?: {
    /** free-form self-description: age range, pronouns, whatever they offered */
    demographics?: string;
    fabricLoves: string[];
    fabricHates: string[];
    /** designers/labels already in their life */
    labelsOwned: string[];
    /** "what do you want to change most about your aesthetic" — verbatim */
    changeMost: string;
    /** the projective year-out anchor, verbatim in their words */
    yearOut: {
      wearing: string;
      styleWords: string[];
      city: string;
      identity: string;
    };
    /** thermoregulation beyond runs-hot/cold: do they sweat through layers */
    sweats?: boolean;
    /** ISO datetime intake was completed */
    completedAt: string;
  };
  /** Tier-chase engine. Ships dormant (null) per 2026-07-06 decision. */
  campaign: null | {
    platform: string;
    targetUsd: number;
    deadline: string; // ISO date
    clearedUsd: number;
    dormantMonths: number[]; // 1-12
    pushMonths: number[];
    promoNotes: string;
  };
}

export interface Item {
  id: string;
  profileId: string;
  category: Category;
  brand: string;
  name: string;
  materials: string[];
  colors: string[];
  sizeLabel?: string;
  priceUsd?: number;
  acquiredAt?: string; // ISO date
  wearCount: number;
  careProtocolIds: string[];
  notes?: string;
}

export interface LedgerEntry {
  id: string;
  profileId: string;
  date: string; // ISO date
  description: string;
  brand?: string;
  platform?: string;
  amountUsd: number;
  cleared: boolean;
  itemId?: string;
}

/**
 * Structured perception of a listing, extracted by the LLM. Scoring and gate
 * code matches against these typed fields instead of raw text when present;
 * every array is empty and every nullable is null when the page is silent.
 */
export interface CandidateAttributes {
  /** what the product IS: "tote bag", "messenger bag", "chelsea boot" */
  itemType: string | null;
  colors: string[];
  /** outer/primary construction materials */
  shellMaterials: string[];
  liningMaterials: string[];
  /** distinct ways to carry (bags): "top handle", "shoulder", "crossbody", "backpack" */
  carryModes: string[];
  /** true = page states a laptop fits; null = page silent */
  laptopFit: boolean | null;
  /** false = unbranded/subtle exterior; null = page silent */
  visibleBranding: boolean | null;
  /** style adjectives stated on the page, lowercase, verbatim */
  aestheticDescriptors: string[];
}

/** A prospective acquisition, either LLM-extracted from a URL or hand-entered. */
export interface Candidate {
  url?: string;
  brand: string;
  name: string;
  category: Category;
  priceUsd: number | null;
  materials: string[];
  fitDescriptors: string[];
  descriptionText: string;
  /** LLM perception only: a neutral what-this-is summary of the listing. Never used in scoring. */
  digest?: string;
  platform?: string;
  /** structured perception; optional so pre-existing stored candidates stay valid */
  attributes?: CandidateAttributes;
}

export interface GateFinding {
  code: string;
  message: string;
  /** which rule/data file produced this finding */
  source: string;
}

export interface GateResult {
  gate: "A" | "B" | "C";
  name: string;
  passed: boolean;
  violations: GateFinding[];
  notes: GateFinding[];
}

export interface SizingRule {
  brand: string;
  categories: Category[];
  /** optional lowercase terms; a rule with matchTerms only fires when one appears in name/description */
  matchTerms?: string[];
  recommendation: string;
  rationale: string;
  source: string;
}

export interface SizingRec {
  brand: string;
  recommendation: string;
  rationale: string;
  source: string;
  /** true when no brand rule matched and this is the generic biometric baseline */
  fallback: boolean;
}

export interface BudgetStatus {
  month: string; // YYYY-MM
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  priceUsd: number | null;
  overBudgetIfPurchased: boolean;
}

export type Decision = "APPROVE" | "REJECT" | "INSUFFICIENT_DATA";

/**
 * Projected cost-per-wear at decision time: the price divided by the median
 * wears of same-category pieces the owner actually wears. Computed by code
 * (never the LLM), so the celebrated-yes payoff cites real wardrobe history,
 * not a guess. Null projection when the piece is unpriced or there is no worn
 * same-category history yet.
 */
export interface CostProjection {
  projectedCostPerWear: number | null;
  /** how many worn same-category vault pieces the median is drawn from */
  wearSample: number;
  /** the median wear count used, or null when there is no history */
  medianWears: number | null;
}

export interface Verdict {
  id: string;
  at: string; // ISO datetime
  profileId: string;
  candidate: Candidate;
  decision: Decision;
  missingData: string[];
  gates: GateResult[];
  sizing: SizingRec;
  budget: BudgetStatus;
  /** care obligations this acquisition commits the owner to */
  careCommitment: string[];
  /** projected cost-per-wear at decision time, from real vault history */
  costProjection: CostProjection;
}

/** Declared by the human at the moment of comparison. Never inferred. */
export type Love = 1 | 2 | 3 | 4 | 5;

/**
 * A stated need being shopped against ("black boots that survive a wet
 * winter"). Candidates accumulate on the quest instead of evaporating after
 * each verdict; the budget is a band (target → stretch), not a point.
 */
export interface Quest {
  id: string;
  profileId: string;
  title: string;
  category: Category;
  /** lowercase requirement terms; matched via structured attributes, then aliases, then text */
  mustHaves: string[];
  niceToHaves: string[];
  /** dealbreaker preferences; a match here penalizes need-fit and is named in the rationale */
  mustNotHaves?: string[];
  targetUsd: number;
  /** absolute ceiling of the band; love unlocks the span between target and here */
  stretchUsd: number;
  deadline?: string; // ISO date
  status: "open" | "decided" | "abandoned";
  createdAt: string; // ISO datetime
  candidates: QuestCandidate[];
}

export interface QuestCandidate {
  id: string;
  addedAt: string; // ISO datetime
  candidate: Candidate;
  /** the full gate verdict this candidate ran through, for the audit trail */
  verdictId: string;
  gatePassed: boolean;
  /** violation messages, denormalized so the quest view never re-reads verdicts.jsonl */
  gateViolations: string[];
  score: CandidateScore;
  /** deterministic plain-language explanation of the scores, composed by code */
  rationale?: string;
  love?: Love;
  /**
   * The eye: the owner's declared aesthetic verdict for THIS candidate,
   * made by looking at it (product photos live outside what extraction
   * reads). Human-declared like love, stored verbatim, scored by code:
   * "on" = aesthetic 100, "off" = aesthetic 0, unset = text evidence rules.
   * Never touches a gate.
   */
  eye?: EyeVerdict;
}

export type EyeVerdict = "on" | "off";

/** Every number computed by code from named data; nothing model-estimated. */
export interface CandidateScore {
  needFit: {
    score: number; // 0-100
    mustMatched: string[];
    mustMissed: string[];
    niceMatched: string[];
    niceMissed: string[];
    /** must-NOT-haves the listing matched; each one costs need points */
    mustNotHit?: string[];
    /** term → channel that matched it ("extracted color (black)", "listing text (…)") */
    matchedVia?: Record<string, string>;
  };
  aestheticFit: {
    score: number; // 0-100
    signalsMatched: string[];
    preferredHits: string[];
    /**
     * false = the listing text contained no aesthetic markers either way.
     * Absence of evidence is not negative evidence: the composite reweights
     * to need + budget instead of counting a silent listing as ugly.
     */
    evidence: boolean;
    /** set when the owner's eye decided this axis instead of listing text */
    declared?: EyeVerdict;
  };
  budgetFit: {
    score: number; // 0-100
    withinTarget: boolean;
    withinStretch: boolean;
    /** price minus quest target; negative = under target; null when unpriced */
    deltaUsd: number | null;
    /** price / median wears of same-category vault items; null without data */
    projectedCostPerWear: number | null;
    /** how many vault items the wear median came from (0 = no projection) */
    wearSample: number;
  };
  /** weighted composite 0-100 (weights are code constants, cited in the UI) */
  total: number;
}

/** One row per closed quest: what won, what lost, and why, in the owner's words. */
export interface DecisionRecord {
  id: string;
  at: string; // ISO datetime
  profileId: string;
  questId: string;
  questTitle: string;
  outcome: "purchased" | "chosen" | "abandoned";
  chosen?: DecisionFinalist;
  rejected: DecisionFinalist[];
  /** the owner's one-line reason, verbatim */
  motivation: string;
  /** true when the chosen price exceeded the quest target (love flex was spent) */
  stretchUsed: boolean;
  itemId?: string;
  ledgerEntryId?: string;
}

export interface DecisionFinalist {
  candidateId: string;
  brand: string;
  name: string;
  priceUsd: number | null;
  total: number;
  love?: Love;
  gatePassed: boolean;
}

export interface CareProtocol {
  id: string;
  label: string;
  /** lowercase material substrings that auto-assign this protocol */
  materialMatch: string[];
  intervalDays: number;
  directive: string;
  /** protocols whose items are at risk in sustained rain */
  rainSensitive: boolean;
}

export interface CareLogEntry {
  id: string;
  profileId: string;
  itemId: string;
  protocolId: string;
  date: string; // ISO date
}

export interface CareTask {
  itemId: string;
  itemLabel: string;
  protocolId: string;
  protocolLabel: string;
  directive: string;
  dueSince: string; // ISO date the interval elapsed
  overdueDays: number;
  /** protocol cadence, surfaced so a task explains its own rhythm */
  intervalDays: number;
  /** where the clock started: a completed care log, the item's acquisition date, or first-seen */
  anchorSource: "care-log" | "acquired" | "first-seen";
  anchorDate: string; // ISO date the clock started
}

/**
 * Invisible-in ingestion: one proposed vault entry, extracted from an
 * order-confirmation email by the LLM (perception only). A proposal is NOT
 * inventory: nothing reaches the vault or the ledger until the owner
 * confirms, and that write is plain code. "unknown" (null/empty) is legal
 * for every extracted field.
 */
export interface IngestProposal {
  id: string;
  profileId: string;
  at: string; // ISO datetime the proposal was created
  /** provenance: which email produced this proposal */
  source: {
    messageId: string;
    from: string;
    subject: string;
    receivedAt: string | null; // ISO date if the email carried one
  };
  merchant: string | null;
  orderRef: string | null;
  orderDate: string | null; // YYYY-MM-DD
  item: {
    brand: string | null;
    name: string;
    category: Category | null;
    priceUsd: number | null;
    sizeLabel: string | null;
    colors: string[];
    materials: string[];
  };
  confidence: "high" | "medium" | "low";
  status: "proposed" | "confirmed" | "dismissed";
  /** set when confirmed: the vault item this proposal became */
  itemId?: string;
}

export interface WeatherDay {
  date: string;
  tMaxF: number;
  tMinF: number;
  precipProb: number; // 0-100
  precipSumMm: number;
}

export interface WeatherAlert {
  severity: "warn" | "info";
  message: string;
  itemsAtRisk: { itemId: string; itemLabel: string; directive: string }[];
}
