import { describe, expect, it } from "vitest";
import {
  decisionOutcomes,
  loveCeiling,
  loveNeeded,
  medianCategoryWears,
  rankQuest,
  rationaleFor,
  scoreCandidate,
  withQuestsLock,
} from "../src/quests.js";
import type {
  Candidate,
  DecisionRecord,
  Item,
  Love,
  Profile,
  Quest,
  QuestCandidate,
} from "../src/types.js";
import { profile as seedProfile } from "./fixtures.js";

const profile: Profile = structuredClone(seedProfile);
profile.aesthetic.approvedSignals = ["monochrome", "structured shoulder"];
profile.materialRules.preferred = [
  { match: ["leather"], unless: ["faux leather"], reason: "ages well" },
];

function quest(over: Partial<Quest> = {}): Quest {
  return {
    id: "qst_test",
    profileId: profile.id,
    title: "black boots",
    category: "footwear",
    mustHaves: ["leather", "black"],
    niceToHaves: ["side zip"],
    targetUsd: 400,
    stretchUsd: 600,
    status: "open",
    createdAt: "2026-07-10T00:00:00.000Z",
    candidates: [],
    ...over,
  };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    brand: "Test Brand",
    name: "Test Boot",
    category: "footwear",
    priceUsd: 350,
    materials: ["leather"],
    fitDescriptors: [],
    descriptionText: "black leather boot with side zip",
    ...over,
  };
}

function questCandidate(
  q: Quest,
  over: Partial<Candidate>,
  extra: { love?: Love; gatePassed?: boolean; id?: string } = {},
): QuestCandidate {
  const c = candidate(over);
  return {
    id: extra.id ?? `qcd_${Math.abs(JSON.stringify(over).length)}_${over.name ?? ""}`,
    addedAt: "2026-07-10T00:00:00.000Z",
    candidate: c,
    verdictId: "vrd_test",
    gatePassed: extra.gatePassed ?? true,
    gateViolations: [],
    score: scoreCandidate(q, profile, c, []),
    love: extra.love,
  };
}

describe("scoreCandidate: need fit", () => {
  it("scores 100 when every must and nice marker is present", () => {
    const s = scoreCandidate(quest(), profile, candidate(), []);
    expect(s.needFit.score).toBe(100);
    expect(s.needFit.mustMissed).toEqual([]);
  });

  it("loses the proportional must share for a missing must-have", () => {
    const s = scoreCandidate(
      quest(),
      profile,
      candidate({ descriptionText: "black suede boot with side zip", materials: ["suede"] }),
      [],
    );
    // 1 of 2 musts (35) + 1 of 1 nice (30)
    expect(s.needFit.score).toBe(65);
    expect(s.needFit.mustMissed).toEqual(["leather"]);
  });

  it("grants full shares when a quest defines no markers", () => {
    const s = scoreCandidate(
      quest({ mustHaves: [], niceToHaves: [] }),
      profile,
      candidate(),
      [],
    );
    expect(s.needFit.score).toBe(100);
  });
});

describe("scoreCandidate: aesthetic fit", () => {
  it("credits doctrine signals and preferred materials at 25 points each", () => {
    const s = scoreCandidate(
      quest(),
      profile,
      candidate({ descriptionText: "monochrome black leather boot" }),
      [],
    );
    // signal "monochrome" + preferred "leather"
    expect(s.aestheticFit.score).toBe(50);
    expect(s.aestheticFit.signalsMatched).toEqual(["monochrome"]);
    expect(s.aestheticFit.preferredHits).toEqual(["leather"]);
  });

  it("respects a preferred rule's unless clause", () => {
    const s = scoreCandidate(
      quest(),
      profile,
      candidate({ materials: ["faux leather"], descriptionText: "black faux leather boot" }),
      [],
    );
    expect(s.aestheticFit.preferredHits).toEqual([]);
  });
});

describe("scoreCandidate: budget fit", () => {
  it("scores 100 at or under target", () => {
    const s = scoreCandidate(quest(), profile, candidate({ priceUsd: 400 }), []);
    expect(s.budgetFit.score).toBe(100);
    expect(s.budgetFit.withinTarget).toBe(true);
  });

  it("decays linearly 100→40 across the target→stretch band", () => {
    const s = scoreCandidate(quest(), profile, candidate({ priceUsd: 500 }), []);
    expect(s.budgetFit.score).toBe(70); // midpoint of 400→600
    expect(s.budgetFit.withinTarget).toBe(false);
    expect(s.budgetFit.withinStretch).toBe(true);
  });

  it("scores 0 past the stretch ceiling and on unknown price", () => {
    expect(scoreCandidate(quest(), profile, candidate({ priceUsd: 601 }), []).budgetFit.score).toBe(0);
    const unpriced = scoreCandidate(quest(), profile, candidate({ priceUsd: null }), []);
    expect(unpriced.budgetFit.score).toBe(0);
    expect(unpriced.budgetFit.deltaUsd).toBeNull();
  });

  it("projects cost-per-wear from the median of worn same-category items", () => {
    const items: Item[] = [
      { id: "a", profileId: profile.id, category: "footwear", brand: "x", name: "a", materials: [], colors: [], wearCount: 10, careProtocolIds: [] },
      { id: "b", profileId: profile.id, category: "footwear", brand: "x", name: "b", materials: [], colors: [], wearCount: 40, careProtocolIds: [] },
      { id: "c", profileId: profile.id, category: "footwear", brand: "x", name: "c", materials: [], colors: [], wearCount: 0, careProtocolIds: [] },
      { id: "d", profileId: profile.id, category: "tops", brand: "x", name: "d", materials: [], colors: [], wearCount: 99, careProtocolIds: [] },
    ];
    const s = scoreCandidate(quest(), profile, candidate({ priceUsd: 350 }), items);
    // worn footwear: [10, 40] → median 25 → 350/25 = 14
    expect(s.budgetFit.projectedCostPerWear).toBe(14);
    expect(s.budgetFit.wearSample).toBe(2);
  });
});

describe("scoreCandidate: aesthetic evidence", () => {
  it("reweights the composite to need + budget when the listing is aesthetically silent", () => {
    const s = scoreCandidate(
      quest(),
      profile,
      candidate({ materials: ["canvas"], descriptionText: "black canvas tote" }),
      [],
    );
    expect(s.aestheticFit.evidence).toBe(false);
    // need 35 (black only, no nice), budget 100 → (35*0.4 + 100*0.3) / 0.7 = 63
    expect(s.total).toBe(63);
  });

  it("keeps full weighting when any signal or preferred material appears", () => {
    const s = scoreCandidate(quest(), profile, candidate(), []);
    expect(s.aestheticFit.evidence).toBe(true);
    // need 100, aes 25 (leather preferred), budget 100 → 40 + 7.5 + 30 = 78
    expect(s.total).toBe(78);
  });
});

describe("scoreCandidate: the eye", () => {
  it("eye on scores aesthetic 100 with evidence, ignoring the mute listing", () => {
    const s = scoreCandidate(
      quest(),
      profile,
      candidate({ materials: ["canvas"], descriptionText: "black canvas tote" }),
      [],
      "on",
    );
    expect(s.aestheticFit.score).toBe(100);
    expect(s.aestheticFit.evidence).toBe(true);
    expect(s.aestheticFit.declared).toBe("on");
    // need 35, aes 100, budget 100 → 14 + 30 + 30 = 74 (vs 63 reweighted)
    expect(s.total).toBe(74);
  });

  it("eye off scores aesthetic 0 even when text credits the doctrine", () => {
    const s = scoreCandidate(quest(), profile, candidate(), [], "off");
    expect(s.aestheticFit.score).toBe(0);
    expect(s.aestheticFit.evidence).toBe(true);
    expect(s.aestheticFit.declared).toBe("off");
    // text hits are still reported for transparency, just not scored
    expect(s.aestheticFit.preferredHits.length).toBeGreaterThan(0);
  });

  it("unset eye leaves text-evidence behavior untouched", () => {
    const s = scoreCandidate(quest(), profile, candidate(), []);
    expect(s.aestheticFit.declared).toBeUndefined();
    expect(s.total).toBe(78);
  });

  it("rationale names the declaration instead of quoting listing text", () => {
    const q = quest();
    const qc = questCandidate(q, { priceUsd: 300 });
    qc.eye = "on";
    qc.score = scoreCandidate(q, profile, qc.candidate, [], "on");
    const r = rationaleFor(qc, q);
    expect(r).toContain("Your eye called it on-doctrine");
    expect(r).toContain("aesthetic 100");
  });
});

describe("loveNeeded", () => {
  const band = { targetUsd: 400, stretchUsd: 600 };
  it("is 1 at or under target", () => {
    expect(loveNeeded(band, 350)).toBe(1);
    expect(loveNeeded(band, 400)).toBe(1);
  });
  it("steps through the band", () => {
    expect(loveNeeded(band, 450)).toBe(2);
    expect(loveNeeded(band, 500)).toBe(3);
    expect(loveNeeded(band, 600)).toBe(5);
  });
  it("is null past the stretch ceiling", () => {
    expect(loveNeeded(band, 601)).toBeNull();
  });
});

describe("rationaleFor", () => {
  it("leads with the gate rejection and marks it unchoosable", () => {
    const q = quest();
    const qc = questCandidate(q, { priceUsd: 300 }, { gatePassed: false });
    qc.gateViolations = ["Brand X is on the banned-brand register. No exceptions."];
    const r = rationaleFor(qc, q);
    expect(r).toContain("gates reject");
    expect(r).toContain("cannot be chosen");
  });

  it("explains a stretch-priced candidate in terms of the love it needs", () => {
    const q = quest();
    const r = rationaleFor(questCandidate(q, { priceUsd: 500 }), q);
    expect(r).toContain("$100 over target");
    expect(r).toContain("love 3+");
  });

  it("says a silent listing is not counted against the candidate", () => {
    const q = quest();
    const r = rationaleFor(
      questCandidate(q, { materials: ["canvas"], descriptionText: "black canvas tote" }),
      q,
    );
    expect(r).toContain("no aesthetic markers");
    expect(r).toContain("not counted against it");
  });

  it("celebrates a full must-have sweep and an under-target price", () => {
    const q = quest();
    const r = rationaleFor(questCandidate(q, {}), q);
    expect(r).toContain("Hits all 2 must-haves");
    expect(r).toContain("$50 under your $400 target");
  });

  it("flags an unpriced candidate as unrecommendable", () => {
    const q = quest();
    const r = rationaleFor(questCandidate(q, { priceUsd: null }), q);
    expect(r).toContain("Unpriced");
  });
});

describe("loveCeiling", () => {
  const band = { targetUsd: 400, stretchUsd: 600 };
  it("is the target when love is undeclared or 1", () => {
    expect(loveCeiling(band)).toBe(400);
    expect(loveCeiling(band, 1)).toBe(400);
  });
  it("unlocks the band linearly up to the stretch at love 5", () => {
    expect(loveCeiling(band, 3)).toBe(500);
    expect(loveCeiling(band, 5)).toBe(600);
  });
});

describe("rankQuest", () => {
  it("never recommends a gate-rejected candidate, even the top scorer", () => {
    const q = quest();
    q.candidates = [
      questCandidate(q, { name: "Perfect But Banned", priceUsd: 300 }, { gatePassed: false, id: "banned" }),
      questCandidate(q, { name: "Fine", priceUsd: 350, descriptionText: "black leather boot" }, { id: "fine" }),
    ];
    const r = rankQuest(q);
    expect(r.order[0]).toBe("banned"); // still shown first by score
    expect(r.recommendedId).toBe("fine"); // but never recommended
  });

  it("holds an over-target candidate out of reach until love unlocks the band", () => {
    const q = quest();
    q.candidates = [
      questCandidate(q, { name: "Stretch Piece", priceUsd: 550 }, { id: "stretch" }),
    ];
    expect(rankQuest(q).recommendedId).toBeNull();

    q.candidates[0]!.love = 5; // declared love: ceiling 600 now covers 550
    const r = rankQuest(q);
    expect(r.recommendedId).toBe("stretch");
    expect(r.rationale).toContain("stretch band");
  });

  it("never recommends an unpriced candidate", () => {
    const q = quest();
    q.candidates = [questCandidate(q, { name: "Mystery", priceUsd: null }, { love: 5, id: "m" })];
    expect(rankQuest(q).recommendedId).toBeNull();
  });
});

describe("decisionOutcomes", () => {
  it("joins purchases to live wear data and aggregates by love tier", () => {
    const decisions: DecisionRecord[] = [
      {
        id: "dec_1", at: "2026-07-01T00:00:00.000Z", profileId: profile.id,
        questId: "q1", questTitle: "boots", outcome: "purchased",
        chosen: { candidateId: "c1", brand: "x", name: "worn", priceUsd: 100, total: 80, love: 5, gatePassed: true },
        rejected: [], motivation: "loved it", stretchUsed: false, itemId: "itm_worn",
      },
      {
        id: "dec_2", at: "2026-07-02T00:00:00.000Z", profileId: profile.id,
        questId: "q2", questTitle: "jacket", outcome: "purchased",
        chosen: { candidateId: "c2", brand: "x", name: "closet ghost", priceUsd: 200, total: 60, love: 2, gatePassed: true },
        rejected: [], motivation: "seemed practical", stretchUsed: false, itemId: "itm_ghost",
      },
    ];
    const inventory: Item[] = [
      { id: "itm_worn", profileId: profile.id, category: "footwear", brand: "x", name: "worn", materials: [], colors: [], priceUsd: 100, wearCount: 20, careProtocolIds: [] },
      { id: "itm_ghost", profileId: profile.id, category: "outerwear", brand: "x", name: "closet ghost", materials: [], colors: [], priceUsd: 200, wearCount: 0, careProtocolIds: [] },
    ];
    const { outcomes, byLove } = decisionOutcomes(decisions, inventory);
    expect(outcomes[0]!.costPerWear).toBe(5);
    expect(outcomes[1]!.wearCount).toBe(0);

    const love5 = byLove.find((t) => t.love === 5)!;
    const love2 = byLove.find((t) => t.love === 2)!;
    expect(love5.avgCostPerWear).toBe(5);
    expect(love2.unworn).toBe(1);
    expect(love2.avgCostPerWear).toBeNull();
  });
});

describe("withQuestsLock", () => {
  it("serializes overlapping mutations so neither sees a stale snapshot", async () => {
    const order: string[] = [];
    const slow = withQuestsLock(async () => {
      order.push("slow:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow:end");
      return "slow";
    });
    const fast = withQuestsLock(async () => {
      order.push("fast:start");
      return "fast";
    });
    expect(await Promise.all([slow, fast])).toEqual(["slow", "fast"]);
    expect(order).toEqual(["slow:start", "slow:end", "fast:start"]);
  });

  it("keeps the queue alive after a rejected mutation", async () => {
    await expect(
      withQuestsLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withQuestsLock(async () => "recovered")).resolves.toBe("recovered");
  });
});
