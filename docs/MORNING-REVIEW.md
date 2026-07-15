# Morning review: overnight visual uplevel

**Branch:** `overnight-uplevel-20260715` (this worktree only; nothing pushed, merged, or deployed)
**Base:** `3a869ce` (the tip of `ship-day-fixes`, so your three ship-day bug fixes are underneath everything here)
**One-line revert:** `git branch -D overnight-uplevel-20260715` deletes the whole night. To pull back a single file: `git checkout 3a869ce -- public/app.css` (or `public/index.html`, `src/frontend/app.ts`, `public/manifest.webmanifest`).

A worktree note: your worktree HEAD was `74ea17a` (origin/main), which predates the ship-day fixes and the runway-film idea entry in FUTURE-IDEAS.md. I branched from `3a869ce` instead so this work sits on your actual current state. Also, the `monolith-fake-auth` launch config runs `npm start` in the main checkout, which would have served the wrong tree and written my demo seed data into your real `data/`. I ran the identical fake-auth server from this worktree instead (same command, same port 4600), so all demo data lives in this worktree's gitignored `data/` and your real data was never touched.

## The one-paragraph version

The app now opens like a show: an original, CSS-only runway film at the top (near-black stage, the app icon's monolith slab edge-lit, one continuous 56-second spotlight pass, film grain, a barely perceptible push-in), flowing into an ink proscenium (dark top bar and tab bar) that frames the bone paper where decisions are read. Underneath that, a real design system: tokens, a type scale that runs from tracked miniature caps to 200-weight display, patient motion (0.7s default, never bouncy), hairline focus states, and 16px inputs that stop iOS zooming your forms. Every verdict state, the quests, the intake, the wear log, and CAPITAL were restyled inside that system. Zero behavior changes, zero new network weight, zero console errors, all 208 tests green at every commit.

## Changelog by surface

Screenshots for every surface, before and after, mobile and desktop, live in `docs/review-screens/before/` and `docs/review-screens/after/`. A reduced-motion still is at `after/reduced-motion-still--mobile.png`. Full sets also in the session scratchpad (`shots-before/`, `shots-after/`, `shots-after-reduced/`).

### 1. Global design system (`5bbd106`)
- `public/app.css` consolidated from 515 lines of append-history into one tokenized system: bone/ink palette plus a dark-stage token set, type scale, spacing rhythm, motion primitives (`surface-in`, `breathe`, ease `cubic-bezier(0.22,1,0.36,1)`).
- Why: everything after this inherits; the uplevel is a system, not point fixes. That was the explicit ask in FUTURE-IDEAS ("a design direction or system, not just point fixes").
- Details worth noticing: `::selection` inverts to ink; keyboard focus is a hairline offset frame everywhere (bone on dark chrome); the CTA hover inverts and letterspaces out over ~1s, which is the whole motion personality in one button; inputs went to 16px mono, which kills the iOS focus-zoom jump; selects finally have a chevron.

### 2. Runway-film header + ink proscenium (`a19cc88`)
- `public/index.html` gained `#runway` above the top bar; `app.css` stages it; `manifest.webmanifest` and the theme-color meta went stage-dark so the PWA chrome matches.
- The film is original and rights-clean: no footage, pure CSS. One continuous unhurried cut (single 56s light pass with a negative delay so it is already onstage at first paint, 90s push-in), not a montage. The slab is the app icon's monolith geometry, restaged and edge-lit, with a floor line and reflection, vignette, and static film grain.
- Guardrails, all verified in real Chromium (the embedded preview pane suppresses rAF/IntersectionObserver, so I verified with Playwright): the film pauses once scrolled offstage (rAF-throttled scroll check in a 12-line inline script); under `prefers-reduced-motion` it holds an intentional lit still; it adds zero bytes of network weight and pushes nothing important below the fold (GATE's paste box and CTA stay well above the fold at 375x812).
- The seam for real footage is documented in `index.html`: drop a `<video class="rw-film" muted autoplay loop playsinline>` as the first child of `.rw-scene` and the CSS already grades it (cover, grayscale, patient); the CSS composition stays as the low-bandwidth and reduced-motion fallback.
- The top bar joined the film as one ink proscenium: wordmark as the credit line, budget strip and account button stacked on a grid (this also fixed the cramped 375px top bar).

### 3. GATE surface (`779d841`)
- Each tab's opening question ("SHOULD I BUY THIS?", "WHAT SIZE DO I ORDER?", "WARDROBE VAULT: WHAT YOU OWN", "BUDGET · JUL") is now the surface's editorial title: 300-weight, clamp(19px, 5.2vw, 25px), tracked caps. Later sections stay miniature caps, so hierarchy finally exists.
- The paste box carries hero weight (min-height 96px), explainer copy got a 60ch measure.
- Verdict cards: 200-weight display heads at clamp(26px, 7.4vw, 40px). APPROVE arrives on a hairline; REJECT is an ink slab; INSUFFICIENT DATA keeps the dashed frame. Cards enter with a slow rise. The celebrated-yes block got the same light-display treatment, and the cost-per-wear numeral reads like a price tag you are glad to see.
- Why: the verdict is the product's dramatic moment; the word now carries the weight the scoring already earned.

### 4. DECIDE surface (`7582567`)
- Composite scores became bib numbers: 300-weight clamp(24px, 6.4vw, 30px) mono via a `.score-num` class (the only app.ts change here, replacing one inline style).
- Quest titles inherit the light editorial title scale; the brief keeps its ink rule.

### 5. Chrome and states (`b5badaf`)
- The one-tap wear log is now a stage door: it rises off the ink tab bar as a dark panel with bone chips (selected = bone slab) and an inverted CTA. Fast to use, impossible to miss, visually one world with the proscenium.
- CAPITAL's remaining budget is the surface's single large numeral with a tracked "LEFT TO SPEND" unit.
- The intake got a hairline progress bar under the step count; with the film above, the first-run intake now opens like a show program.
- LOADING/CHECKING states breathe slowly; true empty states stay still.

### 6. Polish (final commit)
- Tappable rows (history, quest list) invite quietly on hover.
- Full before/after screenshot sets committed under `docs/review-screens/`.

## app.ts diffs, since that file was guarded

Seven markup-only edits, no logic touched: `.score-num` class swap (quests), `.capital-num`/`.capital-unit` class swap (CAPITAL), three `empty loading` class additions, one intake progress-bar line. `git diff 3a869ce..HEAD -- src/frontend/app.ts` is short and readable.

## Open taste decisions (I took the safe path; you may want the bolder one)

1. **Full dark mode.** The brief says "dark, architectural." I kept the bone paper for the reading surfaces and put the dark into the film, chrome, wear log, and REJECT slab. The bolder move is a fully dark app. I chose bone because the utility moments (verdict findings, forms, quest math) are measurably more legible on light ground, and a full inversion overnight would have risked every surface at once. The token system makes a dark theme a contained follow-up: every color in the app is now a variable.
2. **Real footage in the header.** The CSS film is intentional, but a single licensed or self-shot clip (your runway-film idea as literally filmed fabric or architecture) would go further. The seam is ready and documented in `index.html`.
3. **Serif display.** I stayed sans + mono (Rick Owens reads Helvetica, and it keeps the identity). An editorial serif (Didot on Apple platforms) for the surface titles would push it toward Yohji; one-line change per title style if you want to try it.
4. **Page transitions.** Tab switches render instantly with no fade. I left it that way on purpose: the DECIDE surface re-renders on every love/eye tap, and any page-level entrance animation replays on each interaction and reads as lag. Motion lives in the film, the verdict entrance, and the wear-log rise instead.
5. **Wordmark in the film.** The header film carries no text; the wordmark sits in the bar below it. A giant tracked MONOLITH across the film would be louder; I judged it redundant with the credit line directly beneath.

## Verification state as of the last commit

- `npm run typecheck`: clean.
- `npm run build`: clean.
- `npm test`: 14 files, 208 tests, all passing.
- Browser console: zero errors across every surface, both viewports, normal and reduced motion (checked on every captured page load by the screenshot harness).
- Surfaces verified in-browser before and after, at 375x812 and 1280x800: verdict home, verdict APPROVE/REJECT/INSUFFICIENT, quest detail, SIZE, VAULT, CAPITAL, intake, wear prompt. The app has no light/dark theming; it is a single fixed palette by design.
- Reduced motion: global kill switch plus explicit runway still, verified in Chromium with `reducedMotion: "reduce"`.
- Not verifiable tonight: the Clerk-hosted sign-in card (no Clerk keys in fake-auth mode) and a real iOS home-screen install (status-bar/safe-area handling was left exactly as it was; only theme-color changed). Worth a 30-second phone check before you ship.

## What I did not do

- No push, no merge, no deploy, no `fly.toml`, no backend or gate-logic changes, no dependency changes, no data/ writes outside this worktree.
- `main` and `ship-day-fixes` are untouched.
