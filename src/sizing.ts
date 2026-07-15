// Sizing engine: data-driven overrides from the brand sizing matrix.
// Given a brand + category (+ product text), returns the applicable rule
// with its source cited, or the generic biometric baseline.

import type { Category, SizingRec, SizingRule } from "./types.js";
import { readJson } from "./store.js";

interface SizingMatrix {
  rules: SizingRule[];
  genericFallback: {
    recommendation: string;
    rationale: string;
    source: string;
  };
}

export function loadMatrix(): SizingMatrix {
  return readJson<SizingMatrix>("sizing-matrix.json", {
    rules: [],
    genericFallback: {
      recommendation: "No sizing data on file.",
      rationale: "Seed data/sizing-matrix.json.",
      source: "none",
    },
  });
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

export function recommendSize(
  brand: string,
  category: Category,
  productText: string,
  matrix: SizingMatrix = loadMatrix(),
): SizingRec {
  const b = norm(brand);
  const text = norm(productText);

  const brandRules = matrix.rules.filter((r) => {
    const rb = norm(r.brand);
    return (b.includes(rb) || rb.includes(b)) && r.categories.includes(category);
  });

  // Most specific first: rules whose matchTerms hit the product text.
  const withTermHit = brandRules.find(
    (r) => r.matchTerms && r.matchTerms.some((t) => text.includes(norm(t))),
  );
  const general = brandRules.find((r) => !r.matchTerms);
  const rule = withTermHit ?? general;

  if (rule) {
    return {
      brand,
      recommendation: rule.recommendation,
      rationale: rule.rationale,
      source: rule.source,
      fallback: false,
    };
  }
  return {
    brand,
    recommendation: matrix.genericFallback.recommendation,
    rationale: matrix.genericFallback.rationale,
    source: matrix.genericFallback.source,
    fallback: true,
  };
}
