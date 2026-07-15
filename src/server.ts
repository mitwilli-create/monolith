import { Hono } from "hono";
import type { Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "node:path";
import {
  BIND,
  CLERK_PUBLISHABLE_KEY,
  FAKE_AUTH,
  MULTIUSER,
  PORT,
  ROOT,
} from "./config.js";
import { seedDataDir, readJsonl } from "./store.js";
import { requireUser } from "./auth.js";
import { currentUserId, runAsUser } from "./user-context.js";
import { spendLlm } from "./llmcap.js";
import { intakeToProfile } from "./intake.js";
import {
  getActiveProfile,
  loadProfilesFile,
  NoProfileError,
  saveProfile,
  setActiveProfile,
} from "./profiles.js";
import {
  addItem,
  deleteItem,
  loadInventory,
  parseInventoryLines,
  saveInventory,
  updateItem,
} from "./inventory.js";
import {
  addLedgerEntry,
  budgetStatus,
  costPerWear,
  deleteLedgerEntry,
  loadLedger,
} from "./budget.js";
import { dueTasks, loadCareLog, loadProtocols, logCare, weatherAlerts } from "./care.js";
import {
  loadWearLog,
  predictStack,
  recordFor,
  saveWearLog,
  skipWear,
  todayKey,
  upsertWear,
  withWearLock,
} from "./wear.js";
import {
  consumeOauthState,
  exchangeCode,
  ingestAvailable,
  ingestConnected,
  loadProposals,
  loadTokens,
  newOauthState,
  oauthUrl,
  proposalToItem,
  saveProposals,
  saveTokens,
  syncOrders,
  withIngestLock,
} from "./ingest.js";
import { geocode, getForecast } from "./weather.js";
import { loadMatrix, recommendSize } from "./sizing.js";
import { runVerdict } from "./gates/engine.js";
import { extractCandidate, extractionAvailable } from "./extract.js";
import {
  appendDecision,
  decisionOutcomes,
  loadQuests,
  rankQuest,
  rationaleFor,
  readDecisions,
  saveQuests,
  scoreCandidate,
  withQuestsLock,
} from "./quests.js";
import { newId } from "./store.js";
import type {
  Candidate,
  CandidateAttributes,
  Category,
  DecisionFinalist,
  DecisionRecord,
  Item,
  Love,
  Profile,
  Quest,
  QuestCandidate,
  Verdict,
} from "./types.js";
import { CATEGORIES } from "./types.js";
import {
  IntakeSchema,
  isIsoDate,
  ProfileSchema,
  QuestCreateSchema,
  QuestEditSchema,
} from "./validate.js";

seedDataDir(); // local mode only; multi-user dirs are seeded on first touch

const app = new Hono();

function bad(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

/** Carries a status code out of a locked section so the route can still
 *  reply 404/409 instead of a generic 400 after catching it. */
class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// A malformed JSON body makes c.req.json() throw a SyntaxError. Every mutating
// route parses a body, so catch it once here as a clean 400 instead of letting
// each route (or none) guard it. Anything else is a real 500.
app.onError((err, c) => {
  if (err instanceof SyntaxError) return bad("Invalid JSON body.");
  // A signed-in user with no profile yet isn't an error, it's a brand-new
  // account: every data route answers "go do the intake" instead of 500.
  if (err instanceof NoProfileError) {
    return c.json({ ok: false, error: err.message, needsIntake: true }, 409);
  }
  console.error(err);
  return c.json({ ok: false, error: "Internal error." }, 500);
});

// ---------- auth ----------

// Public by design: the frontend asks how to boot (local single-user, or
// multi-user via Clerk) before it has any session. Registered BEFORE the
// auth gate below; contains no user data.
app.get("/api/auth/config", (c) =>
  c.json({
    ok: true,
    multiuser: MULTIUSER,
    fakeAuth: FAKE_AUTH,
    clerkPublishableKey: CLERK_PUBLISHABLE_KEY || null,
  }),
);

// Registered BEFORE the auth gate: the redirect back from Google's consent
// screen routinely arrives after Clerk's short-lived session JWT has
// expired (the consent flow takes longer than the token's life, and only
// the app page refreshes it). Authentication here is the single-use,
// TTL'd state minted at /start, which is bound to the user who started
// the flow — see newOauthState/consumeOauthState in ingest.ts.
app.get("/api/ingest/oauth/callback", async (c) => {
  const { code, state, error } = c.req.query();
  // Consume the state before any branch: an error redirect must burn the
  // single-use state too, or it stays replayable until its TTL.
  const consumed = consumeOauthState(state ?? "");
  if (!consumed.valid) {
    return bad("OAuth state mismatch or missing code. Start the connect flow again.");
  }
  if (error) return bad(`Google returned: ${error}`);
  if (!code) {
    return bad("OAuth state mismatch or missing code. Start the connect flow again.");
  }
  if (MULTIUSER && !consumed.userId) {
    return bad("Sign in and start the connect flow again.");
  }
  if (consumed.userId) {
    await runAsUser(consumed.userId, () => exchangeCode(code));
  } else {
    await exchangeCode(code);
  }
  // Back to the app; the VAULT panel reads /api/ingest/status and shows CONNECTED.
  return c.redirect("/");
});

// Everything else under /api requires a session in multi-user mode (the
// middleware is a no-op in local mode). Store access without the user
// context this middleware pins would throw — fail closed, never shared.
app.use("/api/*", requireUser);

// ---------- profile ----------

app.get("/api/profile", (c) => {
  const file = loadProfilesFile();
  if (file.profiles.length === 0) {
    // Fresh account: nothing on file, next stop is the intake.
    return c.json({ ok: true, needsIntake: true, extractionAvailable: extractionAvailable() });
  }
  return c.json({
    ok: true,
    activeProfileId: file.activeProfileId,
    profiles: file.profiles.map((p) => ({ id: p.id, name: p.name })),
    profile: getActiveProfile(),
    extractionAvailable: extractionAvailable(),
  });
});

/**
 * The deep aspirational intake. Answers arrive raw; intakeToProfile (pure
 * code, unit-tested) builds the Profile — hard fields for the gates, the
 * aspiration block for the soft layer. One intake per account: re-running
 * it later goes through profile edit, not a second intake.
 */
app.post("/api/intake", async (c) => {
  const parsed = IntakeSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return bad(`Invalid intake: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "schema mismatch"}`);
  }
  const file = loadProfilesFile();
  if (file.profiles.length > 0) {
    return bad("A profile already exists; edit it instead of re-running intake.", 409);
  }
  const profile = intakeToProfile(parsed.data, newId("usr"), new Date());
  saveProfile(profile);
  setActiveProfile(profile.id);
  return c.json({ ok: true, profile });
});

/** City search for the intake's location step (keyless Open-Meteo geocoder). */
app.get("/api/geocode", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ ok: true, matches: [] });
  return c.json({ ok: true, matches: await geocode(q.slice(0, 100)) });
});

app.put("/api/profile", async (c) => {
  const body = await c.req.json();
  // Full runtime validation (Qodo r2 finding 1): a profile that fails the
  // schema never reaches disk, so numeric fields stay numeric and no field
  // can smuggle markup into the rendered UI.
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return bad(`Invalid profile: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "schema mismatch"}`);
  }
  return c.json({ ok: true, profile: saveProfile(parsed.data as Profile) });
});

app.post("/api/profile/activate", async (c) => {
  const { id } = await c.req.json();
  try {
    setActiveProfile(String(id));
  } catch {
    return bad("Unknown profile.", 404);
  }
  return c.json({ ok: true });
});

// ---------- extraction + verdict ----------

app.post("/api/extract", async (c) => {
  const { url, pageText } = await c.req.json();
  if (!url && !pageText) return bad("Provide url or pageText.");
  if (url !== undefined && (typeof url !== "string" || url.length > 2048)) {
    return bad("url must be a string of at most 2048 characters.");
  }
  // Manual pageText gets the same discipline as fetched pages (Qodo r2
  // finding 2): typed, and bounded before it can reach the LLM prompt.
  if (pageText !== undefined && typeof pageText !== "string") {
    return bad("pageText must be a string.");
  }
  if (typeof pageText === "string" && pageText.length > 200_000) {
    return bad("pageText too long (max 200,000 characters).", 413);
  }
  if (!spendLlm(currentUserId(), 1).allowed) {
    return bad("Daily reading limit reached — MONOLITH reads again tomorrow.", 429);
  }
  try {
    const result = await extractCandidate({ url, pageText });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return bad(err instanceof Error ? err.message : "Extraction failed.", 502);
  }
});

/**
 * Sanitize client-supplied structured attributes: bounded strings, booleans
 * that are booleans, nothing else survives. Absent/malformed → undefined,
 * which scoring treats as "no structured perception" (text channels only).
 */
function parseAttributes(a: unknown): CandidateAttributes | undefined {
  if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
  const o = a as Record<string, unknown>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .slice(0, 30)
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.toLowerCase().slice(0, 100))
      : [];
  const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    itemType: typeof o.itemType === "string" ? o.itemType.toLowerCase().slice(0, 100) : null,
    colors: strArr(o.colors),
    shellMaterials: strArr(o.shellMaterials),
    liningMaterials: strArr(o.liningMaterials),
    carryModes: strArr(o.carryModes),
    laptopFit: boolOrNull(o.laptopFit),
    visibleBranding: boolOrNull(o.visibleBranding),
    aestheticDescriptors: strArr(o.aestheticDescriptors),
  };
}

/** Normalize a request body into a Candidate, or null on a bad category. */
function parseCandidate(body: Partial<Candidate>): Candidate | null {
  const category = (body.category ?? "tops") as Category;
  if (!CATEGORIES.includes(category)) return null;
  return {
    url: body.url,
    brand: (body.brand ?? "").trim(),
    name: (body.name ?? "").trim(),
    category,
    priceUsd:
      typeof body.priceUsd === "number" && Number.isFinite(body.priceUsd)
        ? body.priceUsd
        : null,
    materials: (body.materials ?? []).map((m) => String(m).toLowerCase()),
    fitDescriptors: (body.fitDescriptors ?? []).map((f) => String(f).toLowerCase()),
    descriptionText: String(body.descriptionText ?? ""),
    digest: body.digest ? String(body.digest).slice(0, 1000) : undefined,
    platform: body.platform ? String(body.platform) : undefined,
    attributes: parseAttributes(body.attributes),
  };
}

app.post("/api/verdict", async (c) => {
  const body = (await c.req.json()) as Partial<Candidate>;
  const candidate = parseCandidate(body);
  if (!candidate) return bad(`Unknown category: ${body.category}`);
  const profile = getActiveProfile();
  const forecast = await getForecast(profile.location.lat, profile.location.lon);
  const verdict = runVerdict(profile, candidate, { forecast });
  return c.json({ ok: true, verdict });
});

app.get("/api/verdicts", (c) => {
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10) || 20;
  const verdicts = readJsonl<Verdict>("verdicts.jsonl", limit).reverse();
  return c.json({ ok: true, verdicts });
});

// ---------- quests / decide ----------

/**
 * Every quest mutation is read-modify-write over the whole quests file, and
 * several await network work (extraction, forecast) between load and save. A
 * mutator that loaded before a concurrent save would write a stale snapshot
 * back, silently dropping the other change. `locked` serializes the entire
 * handler, so each one loads fresh state and saves before the next begins.
 */
const locked =
  (fn: (c: Context) => Promise<Response>) =>
  (c: Context): Promise<Response> =>
    withQuestsLock(() => fn(c));

/** A quest plus its computed ranking; every GET returns quests in this shape. */
function withRanking(q: Quest) {
  return { ...q, ranking: rankQuest(q) };
}

// `id` may be undefined: `locked()` handlers see the base Context type, where
// param() is string | undefined. An absent id finds nothing, which is a 404.
function findOpenQuest(
  id: string | undefined,
  profileId: string,
): { quests: Quest[]; quest: Quest } | null {
  const quests = loadQuests();
  const quest = quests.find(
    (q) => q.id === id && q.profileId === profileId && q.status === "open",
  );
  return quest ? { quests, quest } : null;
}

app.get("/api/quests", (c) => {
  const profile = getActiveProfile();
  const mine = loadQuests().filter((q) => q.profileId === profile.id);
  const open = mine.filter((q) => q.status === "open");
  const closed = mine
    .filter((q) => q.status !== "open")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  return c.json({ ok: true, open: open.map(withRanking), closed: closed.map(withRanking) });
});

app.post("/api/quests", locked(async (c) => {
  const profile = getActiveProfile();
  const parsed = QuestCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return bad(`Invalid quest: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "schema mismatch"}`);
  }
  const b = parsed.data;
  const quest: Quest = {
    id: newId("qst"),
    profileId: profile.id,
    title: b.title,
    category: b.category,
    mustHaves: b.mustHaves.map((m) => m.toLowerCase()),
    niceToHaves: b.niceToHaves.map((m) => m.toLowerCase()),
    mustNotHaves: (b.mustNotHaves ?? []).map((m) => m.toLowerCase()),
    targetUsd: b.targetUsd,
    stretchUsd: b.stretchUsd,
    deadline: b.deadline,
    status: "open",
    createdAt: new Date().toISOString(),
    candidates: [],
  };
  const quests = loadQuests();
  quests.push(quest);
  saveQuests(quests);
  return c.json({ ok: true, quest: withRanking(quest) });
}));

app.put("/api/quests/:id", locked(async (c) => {
  const profile = getActiveProfile();
  const found = findOpenQuest(c.req.param("id"), profile.id);
  if (!found) return bad("Open quest not found.", 404);
  const parsed = QuestEditSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return bad(`Invalid edit: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "schema mismatch"}`);
  }
  const b = parsed.data;
  const q = found.quest;
  if (b.title !== undefined) q.title = b.title;
  if (b.mustHaves !== undefined) q.mustHaves = b.mustHaves.map((m) => m.toLowerCase());
  if (b.niceToHaves !== undefined) q.niceToHaves = b.niceToHaves.map((m) => m.toLowerCase());
  if (b.mustNotHaves !== undefined) q.mustNotHaves = b.mustNotHaves.map((m) => m.toLowerCase());
  if (b.targetUsd !== undefined) q.targetUsd = b.targetUsd;
  if (b.stretchUsd !== undefined) q.stretchUsd = b.stretchUsd;
  if (b.deadline !== undefined) q.deadline = b.deadline === "" ? undefined : b.deadline;
  if (q.stretchUsd < q.targetUsd) return bad("stretchUsd must be >= targetUsd.");

  // Candidates carry their full extracted data, so an edited quest re-scores
  // every contender instantly: no re-reading of listings required. Gates
  // re-run over the same stored data, so a profile change (say, budget policy
  // flipping between advisory and hard stop) stops showing stale gatePassed
  // badges the next time the quest is edited, again without a page fetch.
  const inventory = loadInventory();
  const forecast = await getForecast(profile.location.lat, profile.location.lon);
  for (const qc of q.candidates) {
    const verdict = runVerdict(profile, qc.candidate, { forecast, inventory });
    qc.verdictId = verdict.id;
    qc.gatePassed = verdict.decision !== "REJECT";
    qc.gateViolations = verdict.gates.flatMap((g) => g.violations.map((v) => v.message));
    qc.score = scoreCandidate(q, profile, qc.candidate, inventory, qc.eye);
    qc.rationale = rationaleFor(qc, q);
  }
  saveQuests(found.quests);
  return c.json({ ok: true, quest: withRanking(q) });
}));

/** Hard delete, any status: no decision record. Abandon is the journaled path. */
app.delete("/api/quests/:id", locked(async (c) => {
  const profile = getActiveProfile();
  const quests = loadQuests();
  const next = quests.filter(
    (q) => !(q.id === c.req.param("id") && q.profileId === profile.id),
  );
  if (next.length === quests.length) return bad("Quest not found.", 404);
  saveQuests(next);
  return c.json({ ok: true });
}));

app.post("/api/quests/:id/refresh", locked(async (c) => {
  const profile = getActiveProfile();
  const found = findOpenQuest(c.req.param("id"), profile.id);
  if (!found) return bad("Open quest not found.", 404);
  if (!extractionAvailable()) return bad("Extraction offline (no API key): nothing to re-read.");
  const rereadCount = found.quest.candidates.filter((qc) => qc.candidate.url).length;
  if (rereadCount > 0 && !spendLlm(currentUserId(), rereadCount).allowed) {
    return bad("Daily reading limit reached — MONOLITH reads again tomorrow.", 429);
  }
  const inventory = loadInventory();
  const forecast = await getForecast(profile.location.lat, profile.location.lon);
  let refreshed = 0;
  const failures: string[] = [];
  for (const qc of found.quest.candidates) {
    // Re-read only what has a listing to re-read; manual entries keep their data.
    if (qc.candidate.url) {
      try {
        const { candidate } = await extractCandidate({ url: qc.candidate.url });
        qc.candidate = {
          ...candidate,
          url: qc.candidate.url,
          category: found.quest.category,
        };
        const verdict = runVerdict(profile, qc.candidate, { forecast, inventory });
        qc.verdictId = verdict.id;
        qc.gatePassed = verdict.decision !== "REJECT";
        qc.gateViolations = verdict.gates.flatMap((g) => g.violations.map((v) => v.message));
        refreshed++;
      } catch (err) {
        failures.push(
          `${qc.candidate.brand}, ${qc.candidate.name}: ${err instanceof Error ? err.message : "re-read failed"}`,
        );
      }
    }
    // Every candidate re-scores against current quest + vault state either way.
    qc.score = scoreCandidate(found.quest, profile, qc.candidate, inventory, qc.eye);
    qc.rationale = rationaleFor(qc, found.quest);
  }
  saveQuests(found.quests);
  return c.json({ ok: true, refreshed, failures, quest: withRanking(found.quest) });
}));

app.post("/api/quests/:id/candidates", locked(async (c) => {
  const profile = getActiveProfile();
  const found = findOpenQuest(c.req.param("id"), profile.id);
  if (!found) return bad("Open quest not found.", 404);
  const body = (await c.req.json()) as Partial<Candidate>;
  const candidate = parseCandidate(body);
  if (!candidate) return bad(`Unknown category: ${body.category}`);
  if (!candidate.brand || !candidate.name) return bad("Candidate requires brand and name.");

  // Same three gates as the GATE tab, same audit trail. The quest stores the
  // verdict id plus denormalized violations so the comparison view is one read.
  const forecast = await getForecast(profile.location.lat, profile.location.lon);
  const verdict = runVerdict(profile, candidate, { forecast });
  const score = scoreCandidate(found.quest, profile, candidate, loadInventory());
  const qc: QuestCandidate = {
    id: newId("qcd"),
    addedAt: new Date().toISOString(),
    candidate,
    verdictId: verdict.id,
    gatePassed: verdict.decision !== "REJECT",
    gateViolations: verdict.gates.flatMap((g) => g.violations.map((v) => v.message)),
    score,
  };
  qc.rationale = rationaleFor(qc, found.quest);
  found.quest.candidates.push(qc);
  saveQuests(found.quests);
  return c.json({ ok: true, quest: withRanking(found.quest), verdict });
}));

app.delete("/api/quests/:id/candidates/:cid", locked(async (c) => {
  const profile = getActiveProfile();
  const found = findOpenQuest(c.req.param("id"), profile.id);
  if (!found) return bad("Open quest not found.", 404);
  const before = found.quest.candidates.length;
  found.quest.candidates = found.quest.candidates.filter(
    (qc) => qc.id !== c.req.param("cid"),
  );
  if (found.quest.candidates.length === before) return bad("Candidate not found.", 404);
  saveQuests(found.quests);
  return c.json({ ok: true, quest: withRanking(found.quest) });
}));

app.post("/api/quests/:id/candidates/:cid/love", locked(async (c) => {
  const profile = getActiveProfile();
  const found = findOpenQuest(c.req.param("id"), profile.id);
  if (!found) return bad("Open quest not found.", 404);
  const qc = found.quest.candidates.find((x) => x.id === c.req.param("cid"));
  if (!qc) return bad("Candidate not found.", 404);
  const { love } = await c.req.json();
  if (!Number.isInteger(love) || love < 1 || love > 5) {
    return bad("love must be an integer 1-5.");
  }
  qc.love = love as Love;
  saveQuests(found.quests);
  return c.json({ ok: true, quest: withRanking(found.quest) });
}));

// The eye: declared aesthetic verdict. Re-scores this candidate only; the
// verdict/gates are untouched (the eye is taste, gates are physics + money).
app.post("/api/quests/:id/candidates/:cid/eye", locked(async (c) => {
  const profile = getActiveProfile();
  const found = findOpenQuest(c.req.param("id"), profile.id);
  if (!found) return bad("Open quest not found.", 404);
  const qc = found.quest.candidates.find((x) => x.id === c.req.param("cid"));
  if (!qc) return bad("Candidate not found.", 404);
  const { eye } = await c.req.json();
  if (eye !== "on" && eye !== "off" && eye !== null) {
    return bad('eye must be "on", "off", or null to clear.');
  }
  if (eye === null) delete qc.eye;
  else qc.eye = eye;
  qc.score = scoreCandidate(found.quest, profile, qc.candidate, loadInventory(), qc.eye);
  qc.rationale = rationaleFor(qc, found.quest);
  saveQuests(found.quests);
  return c.json({ ok: true, quest: withRanking(found.quest) });
}));

function toFinalist(qc: QuestCandidate): DecisionFinalist {
  return {
    candidateId: qc.id,
    brand: qc.candidate.brand,
    name: qc.candidate.name,
    priceUsd: qc.candidate.priceUsd,
    total: qc.score.total,
    love: qc.love,
    gatePassed: qc.gatePassed,
  };
}

app.post("/api/quests/:id/decide", locked(async (c) => {
  const profile = getActiveProfile();
  const found = findOpenQuest(c.req.param("id"), profile.id);
  if (!found) return bad("Open quest not found.", 404);
  const body = await c.req.json();
  const qc = found.quest.candidates.find((x) => x.id === String(body.candidateId));
  if (!qc) return bad("Candidate not found.", 404);
  const motivation = String(body.motivation ?? "").trim();
  if (!motivation) return bad("Motivation required: one line on why this one.");

  // Gates are current-state, not add-time-state: re-run before committing so a
  // budget that moved since the candidate was added still gets a say.
  const forecast = await getForecast(profile.location.lat, profile.location.lon);
  const verdict = runVerdict(profile, qc.candidate, { forecast });
  if (verdict.decision === "REJECT") {
    return Response.json(
      {
        ok: false,
        error: "Gates re-ran at decision time and now REJECT this candidate. Love does not override a gate.",
        verdict,
      },
      { status: 409 },
    );
  }

  const record: DecisionRecord = {
    id: newId("dec"),
    at: new Date().toISOString(),
    profileId: profile.id,
    questId: found.quest.id,
    questTitle: found.quest.title,
    outcome: body.recordPurchase ? "purchased" : "chosen",
    chosen: toFinalist(qc),
    rejected: found.quest.candidates.filter((x) => x.id !== qc.id).map(toFinalist),
    motivation,
    stretchUsed: qc.candidate.priceUsd !== null && qc.candidate.priceUsd > found.quest.targetUsd,
  };

  if (body.recordPurchase) {
    const item = addItem(
      {
        profileId: profile.id,
        category: qc.candidate.category,
        brand: qc.candidate.brand,
        name: qc.candidate.name,
        materials: qc.candidate.materials,
        colors: [],
        priceUsd: qc.candidate.priceUsd ?? undefined,
        acquiredAt: new Date().toISOString().slice(0, 10),
        notes: `Quest: ${found.quest.title} · love ${qc.love ?? "undeclared"} · ${motivation}`,
      },
      loadProtocols(),
    );
    record.itemId = item.id;
    if (qc.candidate.priceUsd !== null) {
      const entry = addLedgerEntry({
        profileId: profile.id,
        date: new Date().toISOString().slice(0, 10),
        description: `${qc.candidate.brand}, ${qc.candidate.name}`,
        brand: qc.candidate.brand,
        platform: qc.candidate.platform,
        amountUsd: qc.candidate.priceUsd,
        cleared: true,
        itemId: item.id,
      });
      record.ledgerEntryId = entry.id;
    }
  }

  found.quest.status = "decided";
  saveQuests(found.quests);
  appendDecision(record);
  return c.json({ ok: true, record, quest: withRanking(found.quest) });
}));

app.post("/api/quests/:id/abandon", locked(async (c) => {
  const profile = getActiveProfile();
  const found = findOpenQuest(c.req.param("id"), profile.id);
  if (!found) return bad("Open quest not found.", 404);
  const { motivation } = await c.req.json();
  const record: DecisionRecord = {
    id: newId("dec"),
    at: new Date().toISOString(),
    profileId: profile.id,
    questId: found.quest.id,
    questTitle: found.quest.title,
    outcome: "abandoned",
    rejected: found.quest.candidates.map(toFinalist),
    motivation: String(motivation ?? "").trim() || "abandoned without a stated reason",
    stretchUsed: false,
  };
  found.quest.status = "abandoned";
  saveQuests(found.quests);
  appendDecision(record);
  return c.json({ ok: true, record });
}));

app.get("/api/decisions", (c) => {
  const profile = getActiveProfile();
  const decisions = readDecisions(200).filter((d) => d.profileId === profile.id);
  const inventory = loadInventory().filter((i) => i.profileId === profile.id);
  const { outcomes, byLove } = decisionOutcomes(decisions, inventory);
  return c.json({ ok: true, outcomes: outcomes.reverse(), byLove });
});

// ---------- sizing ----------

app.get("/api/sizing/brands", (c) => {
  const byBrand = new Map<string, Set<string>>();
  for (const rule of loadMatrix().rules) {
    const set = byBrand.get(rule.brand) ?? new Set<string>();
    for (const cat of rule.categories) set.add(cat);
    byBrand.set(rule.brand, set);
  }
  return c.json({
    ok: true,
    brands: [...byBrand.entries()].map(([brand, cats]) => ({
      brand,
      categories: [...cats],
    })),
  });
});

app.get("/api/sizing", (c) => {
  const brand = c.req.query("brand") ?? "";
  const category = (c.req.query("category") ?? "tops") as Category;
  const q = c.req.query("q") ?? "";
  if (!brand.trim()) return bad("brand is required");
  if (!CATEGORIES.includes(category)) return bad(`Unknown category: ${category}`);
  return c.json({ ok: true, sizing: recommendSize(brand, category, q) });
});

// ---------- inventory ----------

app.get("/api/inventory", (c) => {
  const profile = getActiveProfile();
  const items = loadInventory().filter((i) => i.profileId === profile.id);
  const ledger = loadLedger().filter((e) => e.profileId === profile.id);
  return c.json({
    ok: true,
    items: items.map((i) => ({
      ...i,
      costPerWear: costPerWear(i.priceUsd, i.wearCount),
      // linked spend records, so the UI can offer a clean cascade on delete
      linkedLedger: ledger
        .filter((e) => e.itemId === i.id)
        .map((e) => ({ id: e.id, amountUsd: e.amountUsd })),
    })),
  });
});

app.post("/api/inventory", async (c) => {
  const profile = getActiveProfile();
  const body = await c.req.json();
  if (!body?.brand || !body?.name || !body?.category) {
    return bad("Item requires brand, name, category.");
  }
  if (!CATEGORIES.includes(body.category)) return bad(`Unknown category: ${body.category}`);
  const item = addItem(
    {
      profileId: profile.id,
      category: body.category,
      brand: String(body.brand),
      name: String(body.name),
      materials: (body.materials ?? []).map((m: unknown) => String(m).toLowerCase()),
      colors: body.colors ?? [],
      sizeLabel: body.sizeLabel,
      priceUsd: typeof body.priceUsd === "number" ? body.priceUsd : undefined,
      acquiredAt: isIsoDate(body.acquiredAt) ? body.acquiredAt : undefined,
      notes: body.notes,
    },
    loadProtocols(),
  );
  return c.json({ ok: true, item });
});

app.put("/api/inventory/:id", async (c) => {
  const profile = getActiveProfile();
  const patch = (await c.req.json()) as Partial<Item>;
  if (patch.acquiredAt !== undefined && !isIsoDate(patch.acquiredAt)) {
    return bad("acquiredAt must be YYYY-MM-DD.");
  }
  const item = updateItem(c.req.param("id"), profile.id, patch);
  if (!item) return bad("Item not found.", 404);
  return c.json({ ok: true, item });
});

app.delete("/api/inventory/:id", (c) => {
  const profile = getActiveProfile();
  const id = c.req.param("id");
  if (!deleteItem(id, profile.id)) return bad("Item not found.", 404);
  // ?ledger=1 → also remove spend records linked to this item, so undoing a
  // recorded purchase fixes the budget in the same gesture.
  let removedLedger = 0;
  if (c.req.query("ledger") === "1") {
    for (const entry of loadLedger()) {
      if (entry.itemId === id && entry.profileId === profile.id) {
        if (deleteLedgerEntry(entry.id, profile.id)) removedLedger++;
      }
    }
  }
  return c.json({ ok: true, removedLedger });
});

app.post("/api/inventory/:id/wear", (c) => {
  const profile = getActiveProfile();
  const items = loadInventory();
  const item = items.find(
    (i) => i.id === c.req.param("id") && i.profileId === profile.id,
  );
  if (!item) return bad("Item not found.", 404);
  item.wearCount += 1;
  saveInventory(items);
  return c.json({ ok: true, item });
});

app.post("/api/inventory/import", async (c) => {
  const profile = getActiveProfile();
  const { text } = await c.req.json();
  if (!text) return bad("Provide text.");
  const protocols = loadProtocols();
  const { items, errors } = parseInventoryLines(String(text), profile.id, protocols);
  const created = items.map((i) => addItem(i, protocols));
  return c.json({ ok: true, imported: created.length, errors });
});

// ---------- budget / ledger ----------

app.get("/api/budget", (c) => {
  const profile = getActiveProfile();
  const ledger = loadLedger().filter((e) => e.profileId === profile.id);
  const status = budgetStatus(profile, null, ledger);
  return c.json({
    ok: true,
    status,
    entries: ledger.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50),
  });
});

app.post("/api/ledger", async (c) => {
  const profile = getActiveProfile();
  const body = await c.req.json();
  const amount = Number(body?.amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) return bad("amountUsd must be > 0.");
  if (body.date !== undefined && body.date !== "" && !isIsoDate(body.date)) {
    return bad("date must be YYYY-MM-DD.");
  }
  const entry = addLedgerEntry({
    profileId: profile.id,
    date: body.date || new Date().toISOString().slice(0, 10),
    description: String(body.description ?? "purchase"),
    brand: body.brand,
    platform: body.platform,
    amountUsd: amount,
    cleared: body.cleared !== false,
    itemId: body.itemId,
  });
  return c.json({ ok: true, entry });
});

app.delete("/api/ledger/:id", (c) => {
  const profile = getActiveProfile();
  if (!deleteLedgerEntry(c.req.param("id"), profile.id)) {
    return bad("Entry not found.", 404);
  }
  return c.json({ ok: true });
});

// ---------- care ----------

app.get("/api/care", async (c) => {
  const profile = getActiveProfile();
  const items = loadInventory().filter((i) => i.profileId === profile.id);
  const protocols = loadProtocols();
  const log = loadCareLog();
  const forecast = await getForecast(profile.location.lat, profile.location.lon);
  return c.json({
    ok: true,
    tasks: dueTasks(items, protocols, log),
    alerts: weatherAlerts(items, protocols, forecast),
    forecast,
    protocols,
  });
});

app.post("/api/care/log", async (c) => {
  const profile = getActiveProfile();
  const { itemId, protocolId, date } = await c.req.json();
  if (!itemId || !protocolId) return bad("itemId and protocolId required.");
  if (date !== undefined && date !== "" && !isIsoDate(date)) {
    return bad("date must be YYYY-MM-DD.");
  }
  const owned = loadInventory().some(
    (i) => i.id === String(itemId) && i.profileId === profile.id,
  );
  if (!owned) return bad("Item not found.", 404);
  const entry = logCare({
    profileId: profile.id,
    itemId: String(itemId),
    protocolId: String(protocolId),
    date: date || new Date().toISOString().slice(0, 10),
  });
  return c.json({ ok: true, entry });
});

// ---------- one-tap wear log ----------
// The prediction is code (recency-frequency over the owner's own log);
// logging adjusts each piece's wearCount by diff so the counter stays the
// single honest source cost-per-wear reads from.

app.get("/api/wear/today", (c) => {
  const profile = getActiveProfile();
  const date = c.req.query("date") || todayKey();
  if (!isIsoDate(date)) return bad("date must be YYYY-MM-DD.");
  const log = loadWearLog();
  const record = recordFor(log, profile.id, date);
  const items = loadInventory().filter((i) => i.profileId === profile.id);
  return c.json({
    ok: true,
    date,
    logged: !!record && !record.skipped && record.itemIds.length > 0,
    skipped: !!record?.skipped,
    record: record ?? null,
    prediction: predictStack(items, log, profile.id, date).map((i) => ({
      id: i.id,
      brand: i.brand,
      name: i.name,
      category: i.category,
    })),
  });
});

app.post("/api/wear/log", async (c) => {
  const profile = getActiveProfile();
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return bad("Request body must be a JSON object.");
  }
  const date = body.date || todayKey();
  if (!isIsoDate(date)) return bad("date must be YYYY-MM-DD.");
  if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) {
    return bad("itemIds must be a non-empty array (use /api/wear/skip for none).");
  }
  try {
    // Locked: load-modify-save of both inventory wearCounts and the wear
    // log happens as one section, so a concurrent log can't compute its
    // delta from a snapshot the other request is about to invalidate.
    const record = await withWearLock(async () => {
      const items = loadInventory();
      const owned = new Set(
        items.filter((i) => i.profileId === profile.id).map((i) => i.id),
      );
      const result = upsertWear(loadWearLog(), profile.id, date, body.itemIds.map(String), owned);
      for (const [id, delta] of result.deltas) {
        const item = items.find((i) => i.id === id)!;
        updateItem(id, profile.id, { wearCount: Math.max(0, item.wearCount + delta) });
      }
      saveWearLog(result.log);
      return result.record;
    });
    return c.json({ ok: true, record });
  } catch (e) {
    return bad(String((e as Error).message));
  }
});

app.post("/api/wear/skip", async (c) => {
  const profile = getActiveProfile();
  const body = await c.req.json().catch(() => ({}));
  const date = body?.date || todayKey();
  if (!isIsoDate(date)) return bad("date must be YYYY-MM-DD.");
  const record = await withWearLock(async () => {
    const result = skipWear(loadWearLog(), profile.id, date);
    saveWearLog(result.log);
    return result.record;
  });
  return c.json({ ok: true, record });
});

// ---------- invisible-in ingestion ----------
// The LLM's only role is perception (order email → proposal). Every write
// below — vault item, ledger entry, status flip — is plain code, and only
// runs on the owner's explicit request.

app.get("/api/ingest/status", (c) => {
  const profile = getActiveProfile();
  const tokens = loadTokens();
  return c.json({
    ok: true,
    available: ingestAvailable(),
    connected: tokens !== null,
    email: tokens?.email ?? null,
    proposals: loadProposals().filter(
      (p) => p.profileId === profile.id && p.status === "proposed",
    ).length,
  });
});

app.get("/api/ingest/oauth/start", (c) => {
  if (!ingestAvailable()) {
    return bad("Ingestion is off: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (plus ANTHROPIC_API_KEY for extraction).");
  }
  return c.redirect(oauthUrl(newOauthState(currentUserId())));
});

app.post("/api/ingest/disconnect", (c) => {
  saveTokens(null);
  return c.json({ ok: true });
});

app.post("/api/ingest/sync", async (c) => {
  if (!ingestConnected()) return bad("Gmail is not connected.", 409);
  const profile = getActiveProfile();
  // Entry ticket only — syncOrders charges the cap per LLM extraction, so
  // a deep sync costs what it actually reads instead of a flat block.
  if (!spendLlm(currentUserId(), 1).allowed) {
    return bad("Daily reading limit reached — MONOLITH reads again tomorrow.", 429);
  }
  const body = await c.req.json().catch(() => ({}));
  const lookback = Number(body?.lookbackDays);
  const maxEmails = Number(body?.maxEmails);
  const report = await syncOrders(
    profile.id,
    Number.isFinite(lookback) && lookback >= 1 && lookback <= 365 ? Math.floor(lookback) : 60,
    Number.isFinite(maxEmails) && maxEmails >= 1 && maxEmails <= 500 ? Math.floor(maxEmails) : 300,
  );
  return c.json({ ok: true, report });
});

app.get("/api/ingest/proposals", (c) => {
  const profile = getActiveProfile();
  return c.json({
    ok: true,
    proposals: loadProposals()
      .filter((p) => p.profileId === profile.id && p.status === "proposed")
      .sort((a, b) => (b.orderDate ?? b.at).localeCompare(a.orderDate ?? a.at)),
  });
});

app.post("/api/ingest/proposals/:id/confirm", async (c) => {
  const profile = getActiveProfile();
  const body = await c.req.json().catch(() => ({}));

  try {
    const result = await withIngestLock(async () => {
      // Re-load and re-check "still proposed" INSIDE the lock: this is what
      // makes two concurrent confirms of the same proposal mutually
      // exclusive instead of a race where both pass the check and each
      // write their own vault item.
      const proposals = loadProposals();
      const p = proposals.find(
        (x) => x.id === c.req.param("id") && x.profileId === profile.id,
      );
      if (!p) throw new HttpError("Proposal not found.", 404);
      if (p.status !== "proposed") throw new HttpError(`Already ${p.status}.`, 409);

      const converted = proposalToItem(p, {
        category: body.category !== undefined ? String(body.category) : undefined,
        brand: body.brand !== undefined ? String(body.brand) : undefined,
        name: body.name !== undefined ? String(body.name) : undefined,
        priceUsd: body.priceUsd !== undefined ? (body.priceUsd === null ? null : Number(body.priceUsd)) : undefined,
        materials: Array.isArray(body.materials) ? body.materials.map(String) : undefined,
        recordSpend: body.recordSpend === true,
      }, loadProtocols());

      const item = addItem(converted.item, loadProtocols());
      let ledgerEntryId: string | undefined;
      if (converted.ledger) {
        ledgerEntryId = addLedgerEntry({ ...converted.ledger, itemId: item.id }).id;
      }
      // Status flip is the last step and happens before the lock releases:
      // no other request can observe "proposed" for this id again.
      p.status = "confirmed";
      p.itemId = item.id;
      saveProposals(proposals);
      return { item, ledgerEntryId };
    });
    return c.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof HttpError) return bad(e.message, e.status);
    return bad(String((e as Error).message));
  }
});

app.post("/api/ingest/proposals/:id/dismiss", (c) => {
  const profile = getActiveProfile();
  const proposals = loadProposals();
  const p = proposals.find(
    (x) => x.id === c.req.param("id") && x.profileId === profile.id,
  );
  if (!p) return bad("Proposal not found.", 404);
  if (p.status !== "proposed") return bad(`Already ${p.status}.`, 409);
  p.status = "dismissed";
  saveProposals(proposals);
  return c.json({ ok: true });
});

// ---------- weather ----------

app.get("/api/weather", async (c) => {
  const profile = getActiveProfile();
  const forecast = await getForecast(profile.location.lat, profile.location.lon);
  return c.json({ ok: true, forecast, location: profile.location });
});

// ---------- static / PWA shell ----------

app.use(
  "/*",
  serveStatic({
    root: path.relative(process.cwd(), path.join(ROOT, "public")),
  }),
);

serve({ fetch: app.fetch, port: PORT, hostname: BIND }, (info) => {
  console.log(`MONOLITH online: http://localhost:${info.port}`);
});
