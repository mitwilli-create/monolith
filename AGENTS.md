# AGENTS.md — monolith

Read `~/Documents/mission-control/WORKSPACE.md` first: it defines the multi-agent lane rules for this machine. Your lane here (Codex) is building; Claude Code reviews your output and owns orchestration/memory. CodeRabbit reviews commits and PRs automatically.

## What this repo is

MONOLITH: a deterministic wardrobe architect and budget controller, shipped as a mobile-first PWA. Paste a product URL, get an APPROVE / REJECT / INSUFFICIENT_DATA verdict against aesthetic doctrine, material rules, budget, and weather. The design point is structural code gates instead of prompt-level judgment, so LLM failure modes (sycophancy, drift, hallucination) can't leak into verdicts.

## Hard constraints

- **`data/` is live personal state** (inventory, ledger, verdicts, care logs) and is gitignored. Never commit it; never seed tests from it. Committed templates live in `seed/`.
- **`data/verdicts.jsonl` is append-only at runtime.** Code that touches it may only append new lines; never write logic that modifies or rewrites existing ones.
- **All three gates run on every candidate** (A: budget/inventory, B: climate/materials, C: aesthetic) so every violation is reported at once. No short-circuiting.
- **Server binds to `127.0.0.1` with no auth, on purpose.** Remote access goes through an authenticated proxy (Cloudflare Tunnel + Access). Don't add a public bind or weaken this.
- **Stateless server:** profiles are re-read from disk per request. Don't introduce caching without a design conversation.
- `ANTHROPIC_API_KEY` is optional (URL extraction only); everything else must keep working without it. `.env*` is gitignored.

## Commands

- Dev: `npm run dev` (tsx watch) · Run: `npm start` → http://localhost:4600 (override: `MONOLITH_PORT`)
- Build: `npm run build` (esbuild bundle + PWA icons)
- Test: `npm test` (vitest, pure-function suite) · Types: `npm run typecheck`
- Run `npm test` and `npm run typecheck` before declaring any change done.

## Conventions

- TypeScript strict mode (ES2022, NodeNext, `noUncheckedIndexedAccess`), ESM throughout.
- Backend: Hono + zod + @anthropic-ai/sdk. Frontend: vanilla TS/CSS in `src/frontend/`, bundled by esbuild; no framework.
- Gate logic lives in `src/gates/`; keep verdict logic in pure functions so it stays under test.
- Match existing code style; comments only for non-obvious constraints.
