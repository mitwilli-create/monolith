# Future Iteration Ideas

Running log of product/optimization ideas for MONOLITH, captured as they come up. Each entry is a brief, not a spec — status stays "Captured" until a strategy conversation moves it forward.

## Intake format

Every new idea gets logged using this template, in this file, appended under "Logged ideas":

```
## [Short title]

**Status:** Captured
**Date logged:** YYYY-MM-DD
**Source:** how it came in (direct message, email, etc.)

### Summary
1-2 sentence plain description of the idea.

### Why it matters
The value/problem this solves, in a sentence or two.

### Rough shape
Bullet list of what it might involve — features, data, or workflow implied by the idea as stated. Not a spec, just enough to make the idea concrete.

### Open questions for first strategy conversation
Bullet list of the decisions that need to be made before this can be scoped — data sources, build vs. buy, sequencing vs. other roadmap items, cost, technical constraints, success metrics.
```

Statuses progress: `Captured` → `Discussed` → `Scoped` → `In progress` → `Shipped` (or `Shelved`).

---

## Logged ideas

## Barcode / product-data scanning

**Status:** Captured
**Date logged:** 2026-07-15
**Source:** direct message

### Summary
Use the phone camera to scan an item's barcode, auto-log it into inventory, and pull whatever fit, color, and material data is linked to that barcode/UPC.

### Why it matters
Removes manual entry friction from adding items to inventory, and turns a barcode scan into an instant answer to "should I buy/keep this" — fit, aesthetic fit, feel, care, and duplication questions — rather than requiring the user to already know or look up that information.

### Rough shape
- Camera-based barcode scan (mobile web or native) as a new inventory-add path, alongside existing manual/photo entry
- Lookup against a barcode/UPC → product data source (fit, color, material, care)
- Reasoning layer that uses that product data plus the user's existing inventory/profile to answer:
  - Will this fit me / compared to what I already own?
  - Does this align with my aesthetic?
  - How will it feel to wear?
  - How do I wash/dry it to keep it in optimal condition?
  - Do I already own something similar — do I actually need this?

### Open questions for first strategy conversation
- What's the data source for garment info (manufacturer APIs, UPC/barcode databases, product-page scraping, user-submitted)? What's the cost model for barcode/UPC lookups at scale?
- Do we build a materials/care knowledge base ourselves or rely entirely on third-party data — and what's the fallback when a scanned item has no linked data?
- Where does scanned data live — added straight to inventory, or a staging/review step before it's confirmed?
- Which of the five use cases (fit, aesthetic match, feel, care, duplicate-detection) ships first as MVP, and which depend on inventory/profile data that doesn't exist yet?
- Does this require a native app / camera API investment, or is a mobile-web barcode scanner (e.g. via device camera + a JS barcode library) sufficient for v1?
- How does this interact with the existing inventory data model and intake flow (see the DECIDE surface state and MONOLITH productization project notes)?

---

## Full front-end "uplevel" pass

**Status:** Captured
**Date logged:** 2026-07-15
**Source:** direct message

### Summary
Bring in a cross-functional review/design pass — product marketing, visual design, animation/motion, UX, UI, information architecture, fashion designers/manufacturers, and target users — to make the app visually and experientially best-in-class, not just functional.

### Why it matters
The product currently reads as a functional tool. The goal is for it to be stimulating, eye-catching, fun to open, and something users genuinely love using — which is a distinct workstream from feature completeness and likely a prerequisite for retention and for pitching fashion industry partners.

### Rough shape
- Structured review/critique pass across the roles listed (marketing, visual design, animation/motion, UX, UI, IA)
- A pass aimed specifically at fashion designers/manufacturers evaluating MONOLITH as either a market entry point or an acquisition target
- A pass aimed at target end users for reaction/usability feedback
- Likely output: a design direction or system (not just point fixes) that then gets implemented across the existing front end

### Open questions for first strategy conversation
- What's the current baseline — is there an existing design system, brand guidelines, or visual language to build from, or is this a from-scratch direction?
- Sequencing: does this happen before or after further backend/data feature work (e.g. the barcode idea above, multi-user hosting)? Does a rougher UI block user testing of new features, or does an unpolished UI block getting good design feedback?
- Team model: contractor/agency engagement vs. in-house/agentic (Claude-assisted) design work vs. some mix?
- Which roles get engaged first — is this a single combined critique pass, or sequenced (UX/IA first, then visual/motion, then marketing)?
- Is the fashion-designer/manufacturer angle about product feedback, partnership, or acquisition conversations — that changes who's in the room and what's being tested
- What's the success metric — NPS, session length, retention, qualitative "delight" feedback — so the pass has a target to design against?

---

## Runway-film header

**Status:** Captured
**Date logged:** 2026-07-15
**Source:** direct message

### Summary
Make the app header a single long, uncut runway/fashion-film sequence — Rick Owens, GmbH, or Yohji Yamamoto in spirit — that plays out at the top of the app as a core piece of the brand identity.

### Why it matters
Turns the top of the app from a static utility bar into a signature brand moment. A slow, high-fashion runway cut signals the aesthetic seriousness and taste level MONOLITH is going for, sets it apart from typical wardrobe/inventory apps, and reinforces the "app you love to open" goal from the front-end uplevel pass.

### Rough shape
- A single continuous cut (not a montage) looping or playing at the top of the app — runway-walk pacing, high-fashion editorial tone
- Aesthetic references: Rick Owens, GmbH, Yohji Yamamoto — dark, architectural, unhurried
- Lives in the header region as persistent branding, not a one-time splash/intro
- Pairs with the broader front-end uplevel pass (see above) — this is one concrete expression of that direction

### Open questions for first strategy conversation
- Source of the footage: licensed runway film, commissioned/original shoot, AI-generated, or a stylized motion-graphics abstraction that evokes the aesthetic without licensing exposure?
- Licensing/rights — using actual Rick Owens / GmbH / Yohji footage is almost certainly a rights problem; is the goal their *aesthetic* rendered originally, or literally their shows?
- Performance/UX cost: a persistent video header affects load time, battery, data, and can distract from function — autoplay muted? pause on scroll? respect reduced-motion settings?
- Does it play once on open, loop continuously, or change over time (seasonal / per-user)?
- How does it degrade on low-bandwidth or older devices, and what's the static fallback?
- Does a heavy fashion-film header help or hurt the core utility moments (logging, scanning, browsing inventory) directly below it?

---

## Branding, positioning & market-gap council program

**Status:** Captured
**Date logged:** 2026-07-15
**Source:** direct message

### Summary
Stand up a structured program of councils, blind user panels, and cross-model deep research to define MONOLITH's brand, copy, and positioning, honestly assess its value against competitors, and identify the market gaps it's best placed to fill.

### Why it matters
Before pouring effort into branding and front-end polish, MONOLITH needs an outside-in read on where it actually stands: what it's worth relative to alternatives, who loves it vs. who ignores it and why, and which unmet needs it can credibly own. This de-risks the design/branding investment by pointing it at a validated position rather than an assumed one.

### Rough shape
- **Product branding councils** — convene to define brand identity, aesthetic direction, and positioning
- **Copywriter + content-producer councils** — voice, messaging, and content strategy for the product
- **Blind user panels** — recruit both target users *and* "target ignorers" (people in-demographic who would reject or overlook the product), test blind, and mine the ignorers for why they bounce
- **Competitive/value council** — find similar products, assess MONOLITH's actual value vs. competitors and the broader market (honest, not flattering)
- **Cross-model deep research** — run the question across all available models to surface market gaps MONOLITH could push into
- Likely feeds directly into the front-end uplevel pass and the runway-film header direction above

### Open questions for first strategy conversation
- Sequencing: does the competitive/market-gap research come *first* (to aim the branding), or do branding and positioning run in parallel?
- Who are the "target ignorers" precisely, and how do we recruit a blind panel that includes genuine skeptics rather than lukewarm fans?
- Which councils are agentic (Claude/multi-model, e.g. the existing council-of-models + researcher + dealbreaker chain) vs. real human practitioners — and where does each add more signal?
- What's the actual competitive set — is MONOLITH competing with wardrobe/inventory apps, styling services, resale platforms, or something adjacent we haven't named?
- What decision does this program need to produce — a positioning statement, a go/no-go on a market segment, a brand brief — and who owns acting on it?
- Budget and cadence: is this a one-time discovery sprint or a standing feedback loop that keeps running as the product evolves?
