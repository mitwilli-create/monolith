// The matching engine + the trust fixes built on it: word-boundary material
// rules (microsuede is not suede), shell/lining awareness, alias-channel
// requirement matching, must-NOT penalties, aesthetic evidence via extracted
// descriptors, and the comparative rank rationale.

import { describe, expect, it } from "vitest";
import {
  aliasesFor,
  matchRequirement,
  materialRuleHit,
  phraseMatch,
} from "../src/match.js";
import { comparativeLines, rankQuest, scoreCandidate } from "../src/quests.js";
import { runGateB } from "../src/gates/gateB.js";
import type {
  Candidate,
  CandidateAttributes,
  Profile,
  Quest,
  QuestCandidate,
} from "../src/types.js";
import { profile as seedProfile } from "./fixtures.js";

const profile: Profile = structuredClone(seedProfile);
profile.aesthetic.approvedSignals = ["monochrome", "sculptural"];
profile.materialRules.banned = [
  {
    match: ["suede"],
    unless: ["treated", "waterproof"],
    reason: "Untreated suede in the rain.",
  },
];
profile.materialRules.preferred = [{ match: ["leather"], reason: "ages well" }];

function attrs(over: Partial<CandidateAttributes> = {}): CandidateAttributes {
  return {
    itemType: null,
    colors: [],
    shellMaterials: [],
    liningMaterials: [],
    carryModes: [],
    laptopFit: null,
    visibleBranding: null,
    aestheticDescriptors: [],
    ...over,
  };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    brand: "Test Brand",
    name: "Test Bag",
    category: "accessories",
    priceUsd: 350,
    materials: ["full grain leather"],
    fitDescriptors: [],
    descriptionText: "a leather tote bag",
    ...over,
  };
}

function quest(over: Partial<Quest> = {}): Quest {
  return {
    id: "qst_m",
    profileId: profile.id,
    title: "work bag",
    category: "accessories",
    mustHaves: ["leather", "black"],
    niceToHaves: [],
    targetUsd: 400,
    stretchUsd: 600,
    status: "open",
    createdAt: "2026-07-10T00:00:00.000Z",
    candidates: [],
    ...over,
  };
}

function qc(id: string, q: Quest, c: Candidate, gatePassed = true): QuestCandidate {
  const inventory: never[] = [];
  return {
    id,
    addedAt: "2026-07-10T00:00:00.000Z",
    candidate: c,
    verdictId: `vrd_${id}`,
    gatePassed,
    gateViolations: [],
    score: scoreCandidate(q, profile, c, inventory),
  };
}

describe("phraseMatch (word boundaries)", () => {
  it("matches whole words and phrases", () => {
    expect(phraseMatch("suede lining inside", "suede")).toBe(true);
    expect(phraseMatch("made of waxed cotton canvas", "waxed cotton")).toBe(true);
  });

  it("does not match inside larger words: microsuede is not suede", () => {
    expect(phraseMatch("german microsuede lining", "suede")).toBe(false);
    expect(phraseMatch("ultrasuede interior", "suede")).toBe(false);
  });
});

describe("materialRuleHit (shell/lining awareness)", () => {
  const rule = profile.materialRules.banned[0]!;

  it("full-grain leather bag with microsuede lining does not fire the suede ban", () => {
    const c = candidate({
      materials: ["premium full grain leather", "german microsuede"],
      descriptionText: "leather shopper with german microsuede lining",
    });
    expect(materialRuleHit(rule, c, "leather shopper with german microsuede lining premium full grain leather german microsuede")).toBeNull();
  });

  it("real suede in the shell fires as a violation", () => {
    const c = candidate({
      attributes: attrs({ shellMaterials: ["suede"], liningMaterials: ["cotton"] }),
    });
    expect(materialRuleHit(rule, c, "suede chukka")).toEqual({ hit: "suede", where: "shell" });
  });

  it("suede confined to the lining reports as lining, and gate B downgrades it to a note", () => {
    const c = candidate({
      materials: ["full grain leather", "suede"],
      descriptionText: "leather bag with suede lining",
      attributes: attrs({
        shellMaterials: ["full grain leather", "leather"],
        liningMaterials: ["suede"],
      }),
    });
    const hit = materialRuleHit(rule, c, "leather bag with suede lining");
    expect(hit).toEqual({ hit: "suede", where: "lining" });

    const gate = runGateB(profile, c, []);
    expect(gate.passed).toBe(true);
    expect(gate.notes.some((n) => n.code === "MATERIAL_BANNED_LINING")).toBe(true);
  });

  it("unless-terms still suppress the rule", () => {
    const c = candidate({ materials: ["treated suede"] });
    expect(materialRuleHit(rule, c, "treated suede boot")).toBeNull();
  });

  it("unless-terms suppress lining advisories too", () => {
    const c = candidate({
      attributes: attrs({
        shellMaterials: ["leather"],
        liningMaterials: ["treated suede"],
      }),
    });
    expect(materialRuleHit(rule, c, "leather bag, treated suede lining")).toBeNull();
  });
});

describe("matchRequirement (channels)", () => {
  it("matches through aliases: 'laptop pocket' hits a padded compartment", () => {
    const c = candidate();
    const r = matchRequirement("laptop pocket", c, "tote with a padded compartment for devices");
    expect(r.matched).toBe(true);
    expect(r.via).toContain("padded compartment");
  });

  it("matches through structured attributes before text", () => {
    const c = candidate({ attributes: attrs({ colors: ["black"] }) });
    const r = matchRequirement("black", c, "a tote in midnight");
    expect(r.matched).toBe(true);
    expect(r.via).toContain("extracted color");
  });

  it("laptopFit satisfies laptop requirements without page wording", () => {
    const c = candidate({ attributes: attrs({ laptopFit: true }) });
    expect(matchRequirement("pocket for my laptop", c, "no relevant text").matched).toBe(true);
  });

  it("branding terms match on extraction polarity", () => {
    const unbranded = candidate({ attributes: attrs({ visibleBranding: false }) });
    expect(matchRequirement("no visible logo", unbranded, "").matched).toBe(true);
    expect(matchRequirement("visible logo", unbranded, "").matched).toBe(false);
    const branded = candidate({ attributes: attrs({ visibleBranding: true }) });
    expect(matchRequirement("visible logo", branded, "").matched).toBe(true);
    expect(matchRequirement("no visible logo", branded, "").matched).toBe(false);
  });

  it("multi-carry requirements match when 2+ carry modes were extracted", () => {
    const c = candidate({ attributes: attrs({ carryModes: ["top handle", "crossbody"] }) });
    expect(matchRequirement("more than one way to carry", c, "").matched).toBe(true);
  });

  it("literal substring fallback keeps pre-alias behavior", () => {
    const c = candidate();
    expect(matchRequirement("tote", c, "a leather tote bag").matched).toBe(true);
    expect(aliasesFor("tote")).toContain("shopper");
  });

  it("specific concepts suppress generic ones: any pocket is not a laptop pocket", () => {
    const aliases = aliasesFor("pocket for my laptop");
    expect(aliases).toContain("laptop compartment");
    expect(aliases).not.toContain("pocket");
    const c = candidate();
    expect(matchRequirement("pocket for my laptop", c, "tote with one slip pocket").matched).toBe(false);
    expect(matchRequirement("pocket for my laptop", c, "tote with padded laptop sleeve").matched).toBe(true);
  });

  it("bare inch tokens do not satisfy laptop requirements (could be a bag width)", () => {
    const c = candidate();
    expect(matchRequirement("laptop", c, 'measures 15" across the base').matched).toBe(false);
  });
});

describe("scoreCandidate (must-not + aesthetic evidence)", () => {
  it("docks 15 need points per matched must-not and lists the hits", () => {
    const q = quest({ mustHaves: ["leather"], mustNotHaves: ["visible logo"] });
    const c = candidate({ descriptionText: "leather tote with a visible logo plaque" });
    const s = scoreCandidate(q, profile, c, []);
    expect(s.needFit.mustNotHit).toEqual(["visible logo"]);
    // all musts matched (70) + no nice-to-haves set (30) - 15 = 85
    expect(s.needFit.score).toBe(85);
  });

  it("extracted style descriptors count as aesthetic evidence even without doctrine hits", () => {
    const q = quest();
    const c = candidate({
      materials: [],
      descriptionText: "a bag",
      attributes: attrs({ aestheticDescriptors: ["classic", "preppy"] }),
    });
    const s = scoreCandidate(q, profile, c, []);
    expect(s.aestheticFit.evidence).toBe(true);
    expect(s.aestheticFit.score).toBe(0);
  });

  it("doctrine signals credit through aliases: sculptural hits 'architectural'", () => {
    const q = quest();
    const c = candidate({
      attributes: attrs({ aestheticDescriptors: ["architectural"] }),
    });
    const s = scoreCandidate(q, profile, c, []);
    expect(s.aestheticFit.signalsMatched).toContain("sculptural");
  });

  it("a silent listing still reweights aesthetic out", () => {
    const q = quest({ mustHaves: [] });
    const c = candidate({ materials: [], descriptionText: "a bag" });
    const s = scoreCandidate(q, profile, c, []);
    expect(s.aestheticFit.evidence).toBe(false);
  });

  it("records which channel matched each requirement", () => {
    const q = quest({ mustHaves: ["black"] });
    const c = candidate({ attributes: attrs({ colors: ["black"] }), descriptionText: "a bag" });
    const s = scoreCandidate(q, profile, c, []);
    expect(s.needFit.matchedVia?.["black"]).toContain("extracted color");
  });
});

describe("comparativeLines", () => {
  it("explains #1's lead and each lower rank's deficit vs its neighbor", () => {
    const q = quest({ mustHaves: ["leather", "black"] });
    const top = qc("top", q, candidate({
      priceUsd: 300,
      descriptionText: "black leather tote",
    }));
    const bottom = qc("bottom", q, candidate({
      brand: "Other Brand",
      priceUsd: 550,
      descriptionText: "brown leather tote",
    }));
    q.candidates = [top, bottom];
    const ranking = rankQuest(q);
    expect(ranking.order).toEqual(["top", "bottom"]);
    expect(ranking.comparatives["top"]).toContain("Leads #2 (Other Brand)");
    expect(ranking.comparatives["top"]).toContain('"black"');
    expect(ranking.comparatives["bottom"]).toContain("Behind #1");
    expect(ranking.comparatives["bottom"]).toContain("costs $");
  });

  it("a lone candidate gets an honest non-comparison", () => {
    const q = quest();
    q.candidates = [qc("only", q, candidate())];
    const ranking = rankQuest(q);
    expect(ranking.comparatives["only"]).toContain("only contender");
  });

  it("names the lower rank's counter-edge when it matches something the leader misses", () => {
    const q = quest({ mustHaves: ["leather", "black", "laptop compartment"] });
    const top = qc("a", q, candidate({ priceUsd: 200, descriptionText: "black leather tote" }));
    const second = qc("b", q, candidate({
      brand: "Edge Brand",
      priceUsd: 590,
      descriptionText: "black leather tote with laptop compartment",
    }));
    q.candidates = [top, second];
    const lines = comparativeLines(q, rankQuest(q).order);
    const first = rankQuest(q).order[0]!;
    const other = rankQuest(q).order[1]!;
    // Whichever wins, the loser's unique match must be surfaced somewhere.
    expect((lines[first] ?? "") + (lines[other] ?? "")).toContain("laptop compartment");
  });
});
