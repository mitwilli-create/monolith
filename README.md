# MONOLITH

A deterministic wardrobe architect and budget controller, promoted from a gem
configuration to a product. Mobile-first PWA. TypeScript end to end.

## The core idea

The original gem config cataloged four LLM failure modes (sycophancy,
hallucination, context degradation, agentic drift) and tried to mitigate them
with prompt engineering. MONOLITH fixes them structurally:

| Failure mode | Structural fix |
|---|---|
| Sycophancy | Constraint gates are **code**, not prompt. A validator cannot be talked into an exception. |
| Hallucination | The LLM only does perception (page → structured fields) via schema-enforced structured outputs; every numeric claim in a verdict cites its source file; "unknown" is a legal value that produces INSUFFICIENT_DATA, never a guess. |
| Context degradation | The server is stateless per request. Profile constraints are re-read from disk on every call. There is no "middle" to get lost in. |
| Agentic drift | There is no multi-turn agent. Each verdict is a fresh, complete evaluation. |

## Verdict pipeline

```
URL or manual entry
  → extraction (Anthropic structured outputs; only if a key is configured)
  → GATE A · STATE AUDIT      budget position, campaign windows, inventory clash
  → GATE B · CLIMATE FILTER   material rules + live Open-Meteo forecast advisory
  → GATE C · AESTHETIC GATE   doctrine, banned brands, banned fit terms
  → verdict card              APPROVE / REJECT / INSUFFICIENT_DATA
                              + sizing override + capital status + care commitment
  → verdicts.jsonl            append-only audit log
```

All three gates run on every candidate and report every violation (no
short-circuit), so a rejection tells you everything that is wrong at once.

## Surfaces

- **GATE**: paste a product URL, get a verdict. Approvals offer one-tap
  "record purchase" (ledger + vault in one move).
- **DECIDE**: quests + comparison. A quest is one stated need (must-haves,
  nice-to-haves, must-NOT-haves, target price → stretch ceiling). Candidates
  accumulate on it (paste links in bulk), run the same three gates, and get a
  deterministic composite score (need 40% · aesthetic 30% · budget 30%;
  a listing that says nothing about its own style reweights to need + budget
  rather than being scored ugly). Each contender shows an LLM-read neutral
  digest of its listing (perception only, never scored), a code-composed
  plain-language rationale for its numbers, and a comparative line explaining
  its rank against the contender above it. Requirement terms match through
  three deterministic channels in order (src/match.ts): the listing's
  LLM-extracted structured attributes (colors, shell vs lining materials,
  carry modes, laptop fit, visible branding), then a code-owned synonym
  table with word-boundary matching ("laptop compartment" credits a "padded
  16-inch sleeve" page; "suede" no longer fires on "microsuede"), then
  literal substring as the fallback. Banned materials found only in a
  lining are advisory notes, not rejections: the shell is what meets the
  weather. Matched must-NOT-haves dock the need score and are named in the
  rationale. Editing a quest re-scores every contender from stored data and
  re-runs the gates over it, so a profile change (like a budget-policy flip)
  refreshes gate badges without any page fetch; re-reading refreshes digests,
  prices, and structured attributes. Known behavior: text-channel matches
  can still shift on a re-read when the retailer rephrases a listing; that
  is the listing changing, not the scorer. Declared love (1-5, human input
  only) linearly unlocks the target→stretch band and nothing else: it can
  never override a gate. Closing a quest writes a decision record (winner,
  losers, motivation in your own words) to `decisions.jsonl`; THE RECEIPTS
  joins those records back to live wear data so love tiers earn (or lose)
  their reputation over time.
- **SIZE**: brand + category → sizing override from the brand matrix
  (BBS / Rick Owens / Margiela seeded), with the profile's full
  body-measurement spec as a reference table.
- **VAULT**: wardrobe inventory: add, bulk-import, wear tracking,
  cost-per-wear.
- **CAPITAL**: monthly budget, ledger, hard-stop vs advisory policy.
  The tier-chase campaign engine exists but ships dormant (`campaign: null`).
- **CARE**: 7-day forecast, weather-triggered protection alerts for
  rain-sensitive assets, interval-based maintenance schedule per item.

## Run

```sh
npm install
npm run build          # frontend bundle + PWA icons
npm start              # http://localhost:4600
```

Add `ANTHROPIC_API_KEY` to `.env` (see `.env.example`) to enable URL
extraction. Everything else works without it.

**Network exposure is opt-in.** The server binds to `127.0.0.1` by default
because the API has no authentication. For phone use on your own Wi-Fi, start
with `MONOLITH_BIND=0.0.0.0 npm start`, then open
`http://<mac-hostname>.local:4600` and "Add to Home Screen."

**Do not tunnel this to the public internet without an auth layer.** If you
want access anywhere, put an authenticated proxy in front (e.g. Cloudflare
Tunnel + Cloudflare Access, the career-ops dashboard pattern), never a bare
tunnel: every endpoint mutates personal data and would be open to anyone.

## Data layout (`data/`, gitignored, personal)

| File | Contents |
|---|---|
| `profiles.json` | biometrics, measurement spec, aesthetic doctrine, material rules, budget |
| `sizing-matrix.json` | per-brand sizing overrides + generic fallback |
| `inventory.json` | the vault |
| `ledger.json` | spend entries |
| `care-protocols.json` | maintenance protocols + intervals |
| `care-log.json` | executed maintenance |
| `verdicts.jsonl` | append-only verdict audit trail |
| `quests.json` | open + closed quests with their scored candidates |
| `decisions.jsonl` | append-only decision journal (winner, losers, love, motivation) |

`seed/` holds committed templates; missing data files are seeded on boot,
existing ones are never overwritten. Profiles are pure data. A second user
onboards by adding a profile, zero code changes.

## Develop

```sh
npm run dev            # tsx watch
npm test               # vitest: 208 tests
npm run typecheck
```

## v2 parking lot (explicitly out of v1)

Outfit-of-the-day + wardrobe photos · trend/runway/sales scanning agents ·
investment advice · multi-user onboarding UI · campaign activation UI.

## About this repository

This is the public mirror of MONOLITH's working repository. The working repo
stays private because it carries live beta operations. This mirror begins at
the public-hygiene baseline and tracks the same code from there, including the
overnight design uplevel documented in `docs/MORNING-REVIEW.md`.
