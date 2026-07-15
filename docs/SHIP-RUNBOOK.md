# SHIP RUNBOOK — Sprint B beta (multi-user MONOLITH to real strangers)

Everything code-side is done on the `sprint-b-multiuser` branch. This is the
list of things only you can do (accounts, keys, DNS), in order, plus how to
watch the beta once strangers are in. Budget ~2 focused hours end to end.

## 0. What you are shipping

- Multi-user mode turns on when both Clerk keys are set. Every `/api` request
  requires a signed-in session; each user's data lives in `data/users/<id>/`
  (on Fly: `/data/users/<id>/`). No keys = the local single-user app you use
  today, unchanged.
- New users land in the deep aspirational intake (11 screens), which builds
  their profile: gates read the hard answers, doctrine opens from their
  year-out style words, declared fabric hates become refusals that cite the
  intake.
- Per-user LLM spend is capped (default 60 calls/day, `MONOLITH_LLM_DAILY_CAP`)
  so a stranger cannot run up the Anthropic bill.

## 1. Clerk (~20 min)

1. Create an application at dashboard.clerk.com. Sign-in options: email code
   (+ Google if you want). Name it MONOLITH.
2. Copy the **Publishable key** and **Secret key** (API Keys page).
3. Decision — development vs production instance:
   - **Development instance (`pk_test_`/`sk_test_`)**: works on any domain
     immediately, including `*.fly.dev`. User cap (~100) is far beyond a
     handful of strangers. Fastest path; fine for this beta.
   - **Production instance (`pk_live_`)**: requires a domain you control DNS
     for (e.g. `monolith.storytellermitch.com` with a CNAME for Clerk).
     Do this later if the beta graduates.

## 2. Fly.io (~30 min)

```sh
brew install flyctl && fly auth signup    # or fly auth login
cd ~/Documents/monolith
fly launch --no-deploy --copy-config      # accepts the checked-in fly.toml; pick app name + region
# Region MUST match primary_region in fly.toml (else the volume can't attach).
# Note: Seattle (sea) is no longer a Fly region; fly.toml now says sjc.
fly volumes create monolith_data --size 1 --region sjc
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  CLERK_PUBLISHABLE_KEY=pk_test_... \
  CLERK_SECRET_KEY=sk_test_... \
  CLERK_AUTHORIZED_PARTIES=https://<app>.fly.dev
fly deploy
```

Notes:
- If `fly launch` renamed the app, keep `app` in fly.toml in sync.
- **ONE machine, ONE volume — this is a data-integrity invariant, not a cost
  choice.** The file store + in-process locks are per-machine; a second
  machine gets a second volume and silently forks user data. fly.toml cannot
  hard-enforce machine count, so the guard is operational: run
  `fly scale count 1` after every deploy config change, and NEVER create a
  second `monolith_data` volume (a lone volume is itself the backstop —
  scale-out fails without one to attach). If the beta ever needs two
  machines, that is the signal to move the store to shared storage first.
- `fly ssh console` + `ls /data/users/` shows accounts as they appear.
- Backups: `fly ssh sftp shell` → get `/data`, or add a cron later. The volume
  has daily snapshots by default (5-day retention) — check
  `fly volumes snapshots list <volume-id>`.

## 3. Gmail ingestion for beta users (optional at launch, ~15 min)

Invisible-in works per user in multi-user mode (tokens live in each user's own
directory), but Google will show the consent screen for YOUR OAuth client:
1. console.cloud.google.com/apis/credentials → your existing MONOLITH client →
   add authorized redirect URI `https://<app>.fly.dev/api/ingest/oauth/callback`.
2. `fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REDIRECT_URI=https://<app>.fly.dev/api/ingest/oauth/callback`
3. While the OAuth consent screen is in "Testing" mode, add each beta user's
   Gmail as a test user (max 100), or publish the app for verification later.
   Beta-lean call: add testers by hand; it's a handful of strangers.

## 4. Your own account on the hosted app

Sign up like anyone else, run the intake, then either re-enter your quests by
hand (they're few) or copy your local data into your hosted user dir:
`fly ssh sftp shell` → put each `data/*.json` into `/data/users/<your-clerk-id>/`
(find the id via `ls /data/users/` after first sign-in). Your local install
keeps working against local `data/` regardless.

## 5. Invite the strangers (the actual Sprint B milestone)

- 5-10 people with the intentional-consumption problem, across taste levels —
  not just menswear people. Sources: friends-of-friends who complain about
  impulse buys, r/femalefashionadvice + r/malefashionadvice lurkers you know,
  former coworkers.
- Send them: the URL + two sentences. "It's an anti-shopping-assistant: paste
  a link at the moment you're tempted, it gives you an honest verdict against
  your own rules. Takes 5 minutes to set up." Nothing else — watch what they
  do without coaching.

## 6. Watch (the validation questions from the master plan)

Per the plan, success is behavioral. Watch weekly:
- **Point-of-temptation opens**: `fly logs` shows `/api/extract` and
  `/api/verdict` hits per user dir; timestamps tell you if they open it while
  shopping (evenings/weekends) or never.
- **Does the celebrated-yes land?** Ask each user for one sentence after their
  first APPROVE. (No analytics for this — five users, just ask.)
- **Does invisible-in hold?** `ls /data/users/<id>/` — does
  `ingest-proposals.json` fill and `inventory.json` grow without manual adds?
- **Does the intake feel like the product or a form?** Ask after day one.

Kill criteria honesty: if nobody opens it at temptation in two weeks, that IS
the learning — bring it back to the roadmap before building Sprint C.

## Local dev flags (for completeness)

- `MONOLITH_FAKE_AUTH=1 npm start` — multi-user surface without Clerk (sign-in
  skipped, user = `monolith-fake-user` cookie, default "demo"). Refused when
  real Clerk keys are set. Dev only.
- No flags — your daily single-user app, exactly as before Sprint B.
