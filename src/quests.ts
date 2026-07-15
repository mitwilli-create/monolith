// DECIDE engine: quests, comparative scoring, the love band, decisions log.
//
// Same constitution as the gates: every score is computed by code from named
// data. The one subjective input — love — is declared by the human, stored
// verbatim, and flexes only the explicitly-flexible boundary (the span
// between a quest's target and stretch price). It can never override a gate.

import type {
  Candidate,
  CandidateScore,
  DecisionRecord,
  EyeVerdict,
  Item,
  Love,
  Profile,
  Quest,
  QuestCandidate,
} from "./types.js";
import { readJson, writeJson, appendJsonl, readJsonl } from "./store.js";
import { costPerWear } from "./budget.js";
import { matchRequirement, materialRuleHit, aliasesFor, phraseMatch } from "./match.js";

const FILE = "quests.json";
const DECISIONS = "decisions.jsonl";

/** Composite weights. Code constants: the UI cites them, nobody negotiates them. */
export const WEIGHTS = { need: 0.4, aesthetic: 0.3, budget: 0.3 } as const;

// ---------- persistence ----------

export function loadQuests(): Quest[] {
  return readJson<Quest[]>(FILE, []);
}

export function saveQuests(quests: Quest[]): void {
  writeJson(FILE, quests);
}

// Quest mutations are read-modify-write over the whole file, sometimes with
// awaits (extraction, forecast) between load and save. Serialize them so a
// slow mutation can't save a stale snapshot over a faster concurrent one.
// Callers must load quests INSIDE the locked section, never before it.
let questsChain: Promise<unknown> = Promise.resolve();

export function withQuestsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = questsChain.then(fn, fn);
  questsChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function appendDecision(record: DecisionRecord): void {
  appendJsonl(DECISIONS, record);
}

export function readDecisions(limit?: number): DecisionRecord[] {
  return readJsonl<DecisionRecord>(DECISIONS, limit);
}

// ---------- scoring (pure) ----------

function candidateText(c: Candidate): string {
  return [
    c.brand,
    c.name,
    c.descriptionText,
    c.materials.join(" "),
    c.fitDescriptors.join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Match requirement terms via structured attributes → aliases → literal text
 * (src/match.ts). Returns the channel each match came through so the UI can
 * show its work.
 */
function splitMarkers(
  markers: string[],
  candidate: Candidate,
  text: string,
): { matched: string[]; missed: string[]; via: Record<string, string> } {
  const matched: string[] = [];
  const missed: string[] = [];
  const via: Record<string, string> = {};
  for (const m of markers) {
    const r = matchRequirement(m, candidate, text);
    if (r.matched) {
      matched.push(m);
      if (r.via) via[m] = r.via;
    } else {
      missed.push(m);
    }
  }
  return { matched, missed, via };
}

/** Median wearCount of worn same-category vault items; the basis for cost-per-wear projection. */
export function medianCategoryWears(
  inventory: Item[],
  profileId: string,
  category: string,
): { median: number | null; sample: number } {
  const wears = inventory
    .filter((i) => i.profileId === profileId && i.category === category && i.wearCount > 0)
    .map((i) => i.wearCount)
    .sort((a, b) => a - b);
  if (wears.length === 0) return { median: null, sample: 0 };
  const mid = Math.floor(wears.length / 2);
  const median =
    wears.length % 2 === 1 ? wears[mid]! : (wears[mid - 1]! + wears[mid]!) / 2;
  return { median, sample: wears.length };
}

/**
 * Score one candidate against a quest + profile. Deterministic:
 *   need      — must-haves 70% + nice-to-haves 30%, by fraction matched
 *   aesthetic — 25 points per doctrine signal or preferred-material hit, capped at 100
 *   budget    — 100 at/under target, linear 100→40 across the band, 0 past stretch
 */
export function scoreCandidate(
  quest: Quest,
  profile: Profile,
  candidate: Candidate,
  inventory: Item[],
  eye?: EyeVerdict,
): CandidateScore {
  const text = candidateText(candidate);

  // NEED
  const must = splitMarkers(quest.mustHaves, candidate, text);
  const nice = splitMarkers(quest.niceToHaves, candidate, text);
  const mustNot = splitMarkers(quest.mustNotHaves ?? [], candidate, text);
  const mustPart =
    quest.mustHaves.length === 0 ? 70 : (must.matched.length / quest.mustHaves.length) * 70;
  const nicePart =
    quest.niceToHaves.length === 0 ? 30 : (nice.matched.length / quest.niceToHaves.length) * 30;
  // A matched must-NOT is a stated dealbreaker the listing walked into:
  // 15 points each, floored at zero, named in the rationale.
  const needScore = Math.max(
    0,
    Math.round(mustPart + nicePart - mustNot.matched.length * 15),
  );

  // AESTHETIC
  // Doctrine signals match through their aliases against the extracted style
  // descriptors first, then the listing text: "sculptural" credits a page
  // that says "architectural silhouette".
  const descriptorText = (candidate.attributes?.aestheticDescriptors ?? []).join(" ");
  const signalsMatched = profile.aesthetic.approvedSignals.filter((s) =>
    aliasesFor(s).some((a) => phraseMatch(descriptorText, a) || phraseMatch(text, a)),
  );
  const preferredHits = profile.materialRules.preferred
    .filter((r) => {
      const hit = materialRuleHit(r, candidate, text);
      return hit !== null && hit.where !== "lining";
    })
    .map((r) => r.match[0]!);
  const textualScore = Math.min(
    100,
    (signalsMatched.length + preferredHits.length) * 25,
  );
  // Evidence = the listing spoke about aesthetics at all. A page that
  // describes its style without hitting your doctrine earns its low score;
  // only a silent page gets reweighted out.
  const textualEvidence =
    signalsMatched.length + preferredHits.length > 0 ||
    (candidate.attributes?.aestheticDescriptors.length ?? 0) > 0;
  // The eye outranks the text: the owner looked at the thing itself, which
  // is more evidence than any listing copy. Still just data into the same
  // code-owned formula; the eye never touches a gate.
  const aestheticScore = eye === undefined ? textualScore : eye === "on" ? 100 : 0;
  const aestheticEvidence = eye !== undefined || textualEvidence;

  // BUDGET
  const price = candidate.priceUsd;
  const { median, sample } = medianCategoryWears(inventory, quest.profileId, quest.category);
  const projectedCostPerWear =
    price !== null && median !== null ? costPerWear(price, median) : null;
  let budgetScore = 0;
  let withinTarget = false;
  let withinStretch = false;
  if (price !== null) {
    withinTarget = price <= quest.targetUsd;
    withinStretch = price <= quest.stretchUsd;
    if (withinTarget) budgetScore = 100;
    else if (withinStretch) {
      const span = quest.stretchUsd - quest.targetUsd;
      budgetScore = span <= 0 ? 0 : Math.round(100 - 60 * ((price - quest.targetUsd) / span));
    }
  }

  // A listing that says nothing about aesthetics is silent, not ugly: with no
  // evidence, the composite reweights to need + budget instead of averaging
  // in a zero the listing never earned.
  const total = aestheticEvidence
    ? Math.round(
        needScore * WEIGHTS.need + aestheticScore * WEIGHTS.aesthetic + budgetScore * WEIGHTS.budget,
      )
    : Math.round(
        (needScore * WEIGHTS.need + budgetScore * WEIGHTS.budget) / (WEIGHTS.need + WEIGHTS.budget),
      );

  return {
    needFit: {
      score: needScore,
      mustMatched: must.matched,
      mustMissed: must.missed,
      niceMatched: nice.matched,
      niceMissed: nice.missed,
      mustNotHit: mustNot.matched,
      matchedVia: { ...must.via, ...nice.via },
    },
    aestheticFit: {
      score: aestheticScore,
      signalsMatched,
      preferredHits,
      evidence: aestheticEvidence,
      ...(eye === undefined ? {} : { declared: eye }),
    },
    budgetFit: {
      score: budgetScore,
      withinTarget,
      withinStretch,
      deltaUsd: price === null ? null : Math.round((price - quest.targetUsd) * 100) / 100,
      projectedCostPerWear,
      wearSample: sample,
    },
    total,
  };
}

// ---------- the love band (pure) ----------

/**
 * How much of the target→stretch span a declared love unlocks.
 * love 1 (or undeclared) → target only; love 5 → the full stretch ceiling.
 * Love never touches the monthly hard stop or any gate: those already ran.
 */
export function loveCeiling(quest: Pick<Quest, "targetUsd" | "stretchUsd">, love?: Love): number {
  const l = love ?? 1;
  return quest.targetUsd + (quest.stretchUsd - quest.targetUsd) * ((l - 1) / 4);
}

/**
 * The lowest love (1-5) whose ceiling covers `priceUsd`, or null when the
 * price sits past the stretch ceiling (no love reaches it).
 */
export function loveNeeded(
  quest: Pick<Quest, "targetUsd" | "stretchUsd">,
  priceUsd: number,
): Love | null {
  if (priceUsd <= quest.targetUsd) return 1;
  if (priceUsd > quest.stretchUsd) return null;
  const span = quest.stretchUsd - quest.targetUsd;
  return Math.min(5, Math.max(1, Math.ceil(1 + (4 * (priceUsd - quest.targetUsd)) / span))) as Love;
}

/**
 * Plain-language explanation of a candidate's scores, composed by code from
 * the same data the numbers came from. Deliberately rank-free and love-free
 * so it stays true as the quest evolves around it.
 */
export function rationaleFor(
  qc: Pick<QuestCandidate, "gatePassed" | "gateViolations" | "score">,
  quest: Pick<Quest, "targetUsd" | "stretchUsd" | "mustHaves">,
): string {
  const s = qc.score;
  const parts: string[] = [];

  if (!qc.gatePassed) {
    parts.push(
      `The gates reject it (${qc.gateViolations[0] ?? "see verdict"}) — it stays visible for comparison but cannot be chosen at any love.`,
    );
  }

  const mustCount = s.needFit.mustMatched.length + s.needFit.mustMissed.length;
  if (mustCount > 0) {
    if (s.needFit.mustMissed.length === 0) {
      parts.push(`Hits all ${mustCount} must-haves.`);
    } else {
      const missed = s.needFit.mustMissed.slice(0, 3).join(", ");
      const more = s.needFit.mustMissed.length > 3 ? ` +${s.needFit.mustMissed.length - 3} more` : "";
      parts.push(
        `Matches ${s.needFit.mustMatched.length} of ${mustCount} must-haves; the listing never mentions: ${missed}${more}.`,
      );
    }
  }
  if (s.needFit.niceMatched.length > 0) {
    parts.push(`Nice-to-haves found: ${s.needFit.niceMatched.join(", ")}.`);
  }
  if ((s.needFit.mustNotHit?.length ?? 0) > 0) {
    parts.push(
      `Has what you excluded: ${s.needFit.mustNotHit!.join(", ")} (need score docked for each).`,
    );
  }

  const hits = [...s.aestheticFit.signalsMatched, ...s.aestheticFit.preferredHits];
  if (s.aestheticFit.declared === "on") {
    parts.push("Your eye called it on-doctrine: aesthetic 100, no listing text consulted.");
  } else if (s.aestheticFit.declared === "off") {
    parts.push("Your eye called it off-doctrine: aesthetic 0, no listing text consulted.");
  } else if (hits.length > 0) {
    parts.push(`Credits your doctrine: ${hits.join(", ")}.`);
  } else if (s.aestheticFit.evidence) {
    parts.push(
      "The listing describes its own style, but none of it lands in your doctrine: aesthetic scored 0 on real evidence, not silence.",
    );
  } else {
    parts.push(
      "The listing shows no aesthetic markers either way, so its rank leans on need + budget (not counted against it).",
    );
  }

  const price = s.budgetFit.deltaUsd;
  if (price === null) {
    parts.push("Unpriced: it cannot be recommended until a price is confirmed.");
  } else if (price <= 0) {
    parts.push(`$${Math.round(-price)} under your $${Math.round(quest.targetUsd)} target.`);
  } else if (s.budgetFit.withinStretch) {
    const need = loveNeeded(quest, quest.targetUsd + price);
    parts.push(
      `$${Math.round(price)} over target — inside the stretch band, but only recommendable at love ${need ?? 5}+.`,
    );
  } else {
    parts.push(
      `$${Math.round(price)} past even the stretch ceiling: no declared love reaches it.`,
    );
  }

  if (s.budgetFit.projectedCostPerWear !== null) {
    parts.push(
      `Projected $${s.budgetFit.projectedCostPerWear}/wear against your wardrobe's record for this category.`,
    );
  }

  return parts.join(" ");
}

export interface QuestRanking {
  /** candidate ids sorted by composite score, best first (all candidates, for display) */
  order: string[];
  /** best gate-passing candidate whose price sits inside its own love ceiling */
  recommendedId: string | null;
  /** one plain-English line explaining the recommendation (or why there is none) */
  rationale: string;
  /** per-candidate line explaining its position vs the neighbor above it (id → line) */
  comparatives: Record<string, string>;
}

function aestheticHitsOf(qc: QuestCandidate): string[] {
  return [...qc.score.aestheticFit.signalsMatched, ...qc.score.aestheticFit.preferredHits];
}

function shortList(items: string[], max = 3): string {
  const shown = items.slice(0, max).map((s) => `"${s}"`).join(", ");
  return items.length > max ? `${shown} +${items.length - max} more` : shown;
}

/**
 * One line per candidate explaining its rank relative to the neighbor above
 * it (#1 explains its lead over #2). Composed from the same stored score
 * data as the numbers, recomputed on every read, so it can never disagree
 * with the ranking it explains.
 */
export function comparativeLines(quest: Quest, order: string[]): Record<string, string> {
  const byId = new Map(quest.candidates.map((c) => [c.id, c]));
  const out: Record<string, string> = {};
  for (let i = 0; i < order.length; i++) {
    const me = byId.get(order[i]!);
    if (!me) continue;
    if (order.length === 1) {
      out[me.id] = "The only contender so far: the rank means nothing yet.";
      continue;
    }
    const vsRank = i === 0 ? 2 : i;
    const vs = byId.get(order[i === 0 ? 1 : i - 1]!);
    if (!vs) continue;

    // Phrase everything as better-vs-worse, then attach the right preamble.
    const better = i === 0 ? me : vs;
    const worse = i === 0 ? vs : me;
    const reasons: string[] = [];

    if (better.gatePassed && !worse.gatePassed) reasons.push("passes the gates");
    const mustGap = better.score.needFit.mustMatched.filter(
      (m) => !worse.score.needFit.mustMatched.includes(m),
    );
    if (mustGap.length > 0) reasons.push(`matches ${shortList(mustGap)}`);
    const aesGap = aestheticHitsOf(better).filter((h) => !aestheticHitsOf(worse).includes(h));
    if (aesGap.length > 0) reasons.push(`earns doctrine credit for ${shortList(aesGap)}`);
    const bd = better.score.budgetFit.deltaUsd;
    const wd = worse.score.budgetFit.deltaUsd;
    if (better.score.budgetFit.score > worse.score.budgetFit.score) {
      reasons.push(
        bd !== null && wd !== null
          ? `costs $${Math.round(wd - bd)} less`
          : "sits better against your budget band",
      );
    }
    // What the lower-ranked one uniquely matches: named so a close call is
    // visibly a close call, not an oracle pronouncement.
    const mustEdge = worse.score.needFit.mustMatched.filter(
      (m) => !better.score.needFit.mustMatched.includes(m),
    );
    const edge =
      mustEdge.length > 0
        ? i === 0
          ? ` #2's counter-edge: ${shortList(mustEdge)}.`
          : ` Its own edge: ${shortList(mustEdge)}.`
        : "";

    const gap = better.score.total - worse.score.total;
    if (gap === 0) {
      out[me.id] = `Tied with #${vsRank} (${vs.candidate.brand}) on composite score.${edge}`;
    } else if (reasons.length === 0) {
      out[me.id] = `Within ${gap} of #${vsRank} (${vs.candidate.brand}): no single decisive difference.`;
    } else if (i === 0) {
      out[me.id] = `Leads #2 (${vs.candidate.brand}) by ${gap} because it ${reasons.join("; ")}.${edge}`;
    } else {
      out[me.id] = `Behind #${vsRank} (${vs.candidate.brand}), which ${reasons.join("; ")}.${edge}`;
    }
  }
  return out;
}

export function rankQuest(quest: Quest): QuestRanking {
  const order = [...quest.candidates]
    .sort((a, b) => b.score.total - a.score.total)
    .map((c) => c.id);

  const eligible = quest.candidates.filter(
    (qc) =>
      qc.gatePassed &&
      qc.candidate.priceUsd !== null &&
      qc.candidate.priceUsd <= loveCeiling(quest, qc.love),
  );
  const comparatives = comparativeLines(quest, order);
  if (eligible.length === 0) {
    const why =
      quest.candidates.length === 0
        ? "No candidates yet."
        : "No candidate both passes the gates and sits inside its love-adjusted budget ceiling. Raise love on a contender you'd stretch for, or find one closer to target.";
    return { order, recommendedId: null, rationale: why, comparatives };
  }
  const best = eligible.reduce((a, b) => (b.score.total > a.score.total ? b : a));
  const price = best.candidate.priceUsd!;
  const ceiling = loveCeiling(quest, best.love);
  const stretchNote =
    price > quest.targetUsd
      ? ` Uses the stretch band: $${Math.round(price)} vs $${Math.round(quest.targetUsd)} target, unlocked by declared love ${best.love ?? 1}/5 (ceiling $${Math.round(ceiling)}).`
      : "";
  return {
    recommendedId: best.id,
    order,
    rationale: `Highest composite (${best.score.total}) among gate-passing candidates within budget ceiling.${stretchNote}`,
    comparatives,
  };
}

// ---------- retrospective (pure) ----------

export interface DecisionOutcome {
  record: DecisionRecord;
  /** live wear data for purchased items, joined from the vault */
  wearCount: number | null;
  costPerWear: number | null;
}

export interface LoveTierStats {
  love: number; // 0 = undeclared
  purchases: number;
  unworn: number;
  avgCostPerWear: number | null;
}

export function decisionOutcomes(
  decisions: DecisionRecord[],
  inventory: Item[],
): { outcomes: DecisionOutcome[]; byLove: LoveTierStats[] } {
  const byId = new Map(inventory.map((i) => [i.id, i]));
  const outcomes = decisions.map((record) => {
    const item = record.itemId ? byId.get(record.itemId) : undefined;
    return {
      record,
      wearCount: item ? item.wearCount : null,
      costPerWear: item ? costPerWear(item.priceUsd, item.wearCount) : null,
    };
  });

  const tiers = new Map<number, { purchases: number; unworn: number; cpws: number[] }>();
  for (const o of outcomes) {
    if (o.record.outcome !== "purchased" || !o.record.chosen) continue;
    const love = o.record.chosen.love ?? 0;
    const t = tiers.get(love) ?? { purchases: 0, unworn: 0, cpws: [] };
    t.purchases++;
    if (o.wearCount === 0) t.unworn++;
    if (o.costPerWear !== null) t.cpws.push(o.costPerWear);
    tiers.set(love, t);
  }
  const byLove = [...tiers.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([love, t]) => ({
      love,
      purchases: t.purchases,
      unworn: t.unworn,
      avgCostPerWear:
        t.cpws.length === 0
          ? null
          : Math.round((t.cpws.reduce((s, n) => s + n, 0) / t.cpws.length) * 100) / 100,
    }));
  return { outcomes, byLove };
}
