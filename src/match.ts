// Requirement matching: the deterministic bridge between what the owner
// typed ("laptop pocket") and what a listing actually says ("padded 16"
// computer sleeve"). Three channels, tried in order:
//
//   1. STRUCTURED — the LLM-extracted CandidateAttributes fields (colors,
//      shell/lining materials, carry modes, laptop fit, visible branding).
//   2. ALIAS TEXT — the term's code-owned synonyms, word-boundary matched
//      against the listing text.
//   3. LITERAL TEXT — plain substring, the original behavior, so nothing
//      that matched before stops matching.
//
// The alias table is a code constant: expanding it is a reviewed change,
// never a model output. The LLM's only role remains perception (filling
// CandidateAttributes from the page); every match decision here is code.

import type { Candidate, CandidateAttributes, MaterialRule } from "./types.js";

/**
 * Canonical concept → phrases that mean the same thing on product pages.
 * Keys and values are lowercase. A requirement term activates a concept when
 * the term contains the key (so "laptop pocket" activates "laptop").
 */
export const CONCEPT_ALIASES: Record<string, string[]> = {
  // features
  // No bare inch tokens ('15"'): on a bag page that is as likely to be a
  // width as a screen size.
  laptop: [
    "laptop sleeve", "laptop compartment", "laptop pocket", "padded sleeve",
    "padded compartment", "computer sleeve", "computer compartment",
    "macbook", "fits a 13", "fits a 15", "fits a 16",
    "tech compartment", "device sleeve",
  ],
  pocket: ["pocket", "pockets", "compartment", "compartments", "slip pocket", "zip pocket"],
  zip: ["zip", "zipper", "zippered", "zip-top", "zip closure", "zips"],
  // carry
  crossbody: ["crossbody", "cross-body", "shoulder strap", "detachable strap", "adjustable strap"],
  backpack: ["backpack straps", "backpack conversion", "converts to a backpack", "back straps"],
  convertible: [
    "convertible", "converts", "two ways to carry", "three ways to carry",
    "multiple carry", "detachable strap", "removable strap", "crossbody strap",
    "shoulder strap", "backpack straps", "top handles and", "wear it three ways",
  ],
  strap: ["strap", "straps", "shoulder strap", "crossbody strap"],
  // branding
  logo: ["logo", "monogram", "branding", "branded", "label", "labels"],
  // materials
  leather: [
    "leather", "lambskin", "calfskin", "cowhide", "goatskin", "vachetta",
    "full grain", "full-grain", "top grain", "pebbled", "pebble-grained",
  ],
  canvas: ["canvas", "cotton twill", "duck cloth"],
  // types
  tote: ["tote", "shopper", "carryall", "carry-all"],
  messenger: ["messenger", "satchel"],
  // colors
  black: ["black", "onyx", "jet", "noir", "coal"],
  // doctrine vocabulary: lets clothing-era signals credit how bag and
  // accessory pages actually talk
  sculptural: ["architectural", "structured silhouette", "sculpted", "geometric"],
  monochrome: ["all black", "all-black", "black on black", "tonal", "monochromatic"],
  utilitarian: ["utility", "functional design", "workwear", "purpose-built"],
  minimal: ["minimalist", "clean lines", "pared-back", "pared back", "understated", "sleek"],
  asymmetric: ["asymmetrical", "off-center", "off-kilter"],
  deconstructed: ["unstructured", "raw-edge", "raw edge", "unfinished seams"],
  "avant-garde": ["avant garde", "experimental", "unconventional"],
};

/** Escape a string for literal use inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary phrase match: "suede" hits "suede lining" but not
 * "microsuede"; "waxed cotton" hits as a phrase. Boundaries are only
 * asserted where the phrase starts/ends with a word character, so terms
 * like `13"` still work.
 */
export function phraseMatch(text: string, phrase: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (!p) return false;
  const lead = /^[a-z0-9]/.test(p) ? "\\b" : "";
  const tail = /[a-z0-9]$/.test(p) ? "\\b" : "";
  return new RegExp(`${lead}${reEscape(p)}${tail}`, "i").test(text);
}

/**
 * Alias phrases a requirement term activates (the term itself included).
 * When a term activates several concepts, a specific one suppresses a
 * generic one it subsumes: "pocket for my laptop" activates laptop AND
 * pocket, but laptop's aliases already contain "pocket"-phrases, so the
 * generic pocket aliases are dropped. Any pocket is not a laptop pocket.
 */
export function aliasesFor(term: string): string[] {
  const t = term.toLowerCase();
  const active = Object.entries(CONCEPT_ALIASES).filter(([concept]) => t.includes(concept));
  const dominated = new Set(
    active
      .filter(([concept]) =>
        active.some(
          ([other, aliases]) =>
            other !== concept && aliases.some((a) => phraseMatch(a, concept)),
        ),
      )
      .map(([concept]) => concept),
  );
  const out = [t];
  for (const [concept, aliases] of active) {
    if (!dominated.has(concept)) out.push(concept, ...aliases);
  }
  return [...new Set(out)];
}

/** True when a term expresses a negative preference ("no visible logo"). */
function isNegatedTerm(term: string): boolean {
  return /\b(no|not|without|zero|anti)\b|(-free)\b/.test(term);
}

export interface RequirementMatch {
  matched: boolean;
  /** which channel matched, for the audit trail (null when missed) */
  via: string | null;
}

/**
 * Match one requirement term against a candidate. Deterministic; the
 * structured channel is only as good as extraction, so the text channels
 * always run as fallback.
 */
export function matchRequirement(term: string, candidate: Candidate, text: string): RequirementMatch {
  const t = term.toLowerCase().trim();
  const attrs = candidate.attributes;

  if (attrs) {
    const structured = matchStructured(t, attrs);
    if (structured) return { matched: true, via: structured };
  }

  for (const alias of aliasesFor(t)) {
    if (phraseMatch(text, alias)) {
      return { matched: true, via: alias === t ? "listing text" : `listing text ("${alias}")` };
    }
  }

  // Literal substring, the pre-alias behavior. Catches partial-word matches
  // the boundary-aware channel deliberately skips.
  if (text.includes(t)) return { matched: true, via: "listing text" };

  return { matched: false, via: null };
}

function matchStructured(term: string, attrs: CandidateAttributes): string | null {
  const fields: Array<[string, string[]]> = [
    ["color", attrs.colors],
    ["shell material", attrs.shellMaterials],
    ["lining", attrs.liningMaterials],
    ["carry options", attrs.carryModes],
    ["style descriptors", attrs.aestheticDescriptors],
  ];
  for (const [label, values] of fields) {
    for (const v of values) {
      const value = v.toLowerCase();
      for (const alias of aliasesFor(term)) {
        if (phraseMatch(value, alias) || phraseMatch(alias, value)) {
          return `extracted ${label} ("${v}")`;
        }
      }
    }
  }

  if (attrs.itemType) {
    const it = attrs.itemType.toLowerCase();
    for (const alias of aliasesFor(term)) {
      if (phraseMatch(it, alias)) return `extracted item type ("${attrs.itemType}")`;
    }
  }

  if (attrs.laptopFit === true && term.includes("laptop")) {
    return "extracted laptop fit";
  }

  // Branding terms match on extraction polarity: "no visible logo" matches
  // an unbranded read, "visible logo" (a must-not, usually) matches a
  // branded one. Mismatched polarity never matches.
  if (/\b(logo|label|branding|monogram)/.test(term)) {
    if (attrs.visibleBranding === false && isNegatedTerm(term)) {
      return "extracted: no visible branding";
    }
    if (attrs.visibleBranding === true && !isNegatedTerm(term)) {
      return "extracted: visible branding";
    }
  }

  // Multi-carry requirements ("more than one way to carry") match when the
  // extraction found 2+ distinct carry modes.
  if (attrs.carryModes.length >= 2 && /(convertible|more than one way|two ways|multiple ways|multiple carry)/.test(term)) {
    return `extracted carry options (${attrs.carryModes.join(", ")})`;
  }

  return null;
}

// ---------- material rules ----------

export interface MaterialRuleHit {
  /** the matched phrase from the rule */
  hit: string;
  /** where it matched; lining hits are advisory, not violations */
  where: "shell" | "lining" | "text";
}

/**
 * Evaluate one material rule against a candidate, shell/lining aware.
 * Word-boundary matching throughout: "suede" no longer fires on
 * "microsuede" (a polyester fabric), the bug that rejected a full-grain
 * leather bag over its lining. When structured attributes exist, a match
 * found only in the lining is reported as such so the caller can downgrade
 * a ban to a note (a suede LINING is not a suede bag in the rain).
 */
export function materialRuleHit(rule: MaterialRule, candidate: Candidate, text: string): MaterialRuleHit | null {
  const unlessFires = (scope: string) =>
    rule.unless?.some((u) => phraseMatch(scope, u)) ?? false;

  const attrs = candidate.attributes;
  if (attrs && (attrs.shellMaterials.length > 0 || attrs.liningMaterials.length > 0)) {
    const shell = attrs.shellMaterials.join(" ").toLowerCase();
    const lining = attrs.liningMaterials.join(" ").toLowerCase();
    for (const m of rule.match) {
      if (phraseMatch(shell, m) && !unlessFires(shell) && !unlessFires(text)) {
        return { hit: m, where: "shell" };
      }
    }
    for (const m of rule.match) {
      if (phraseMatch(lining, m) && !unlessFires(lining) && !unlessFires(text)) {
        return { hit: m, where: "lining" };
      }
    }
    // Structured materials exist and none matched: still scan the full text
    // so rules about construction ("dragging hem") keep working.
  }

  for (const m of rule.match) {
    if (phraseMatch(text, m) && !unlessFires(text)) {
      return { hit: m, where: "text" };
    }
  }
  return null;
}
