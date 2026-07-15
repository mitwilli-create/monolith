// Invisible-in ingestion v1: OAuth Gmail → order-confirmation emails →
// LLM perception → PROPOSALS. The constitution holds end to end: the LLM
// only turns an email into structured fields ("unknown" is legal
// everywhere); proposals are quarantined in their own file; the only path
// into the vault or the ledger is the owner's explicit confirm, executed
// by plain code in the server route.

import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  ANTHROPIC_API_KEY,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  MODEL,
} from "./config.js";
import { htmlToText } from "./extract.js";
import { assignProtocols } from "./inventory.js";
import { spendLlm } from "./llmcap.js";
import { newId, readJson, writeJson } from "./store.js";
import { currentUserId } from "./user-context.js";
import type { CareProtocol, Category, IngestProposal, Item, LedgerEntry } from "./types.js";
import { CATEGORIES } from "./types.js";

const PROPOSALS_FILE = "ingest-proposals.json";
const SEEN_FILE = "ingest-seen.json";
const TOKENS_FILE = "gmail-oauth.json";

const FETCH_TIMEOUT_MS = 20_000;

/** fetch with a hard deadline (mirrors extract.ts's page-fetch timeout): a
 *  hung Google API call must not hold a sync request open indefinitely. */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`Request to ${new URL(url).host} timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- availability + OAuth ----------

export function ingestAvailable(): boolean {
  return GOOGLE_CLIENT_ID.length > 0 && GOOGLE_CLIENT_SECRET.length > 0 && ANTHROPIC_API_KEY.length > 0;
}

interface GmailTokens {
  access_token: string;
  refresh_token: string;
  /** epoch ms the access token dies; refreshed a minute early */
  expiresAt: number;
  email: string | null;
}

export function loadTokens(): GmailTokens | null {
  return readJson<GmailTokens | null>(TOKENS_FILE, null);
}

export function saveTokens(t: GmailTokens | null): void {
  writeJson(TOKENS_FILE, t);
}

export function ingestConnected(): boolean {
  return loadTokens() !== null;
}

/**
 * CSRF states for the OAuth dance, in-memory with a short TTL. A server
 * restart mid-consent just means clicking CONNECT again. Each state is
 * bound to the user who started the flow: the redirect back from Google
 * can arrive after the short-lived session JWT has expired, so the
 * single-use state — not the session — is what attributes the callback.
 */
const pendingStates = new Map<string, { exp: number; userId: string | null }>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function newOauthState(userId: string | null): string {
  const state = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  for (const [s, v] of pendingStates) if (v.exp < now) pendingStates.delete(s);
  pendingStates.set(state, { exp: now + STATE_TTL_MS, userId });
  return state;
}

export function consumeOauthState(
  state: string,
): { valid: true; userId: string | null } | { valid: false } {
  const v = pendingStates.get(state);
  pendingStates.delete(state);
  if (v === undefined || v.exp < Date.now()) return { valid: false };
  return { valid: true, userId: v.userId };
}

export function oauthUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google token endpoint: ${body.error_description || body.error || res.status}`);
  }
  return body;
}

export async function exchangeCode(code: string): Promise<GmailTokens> {
  const body = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: GOOGLE_REDIRECT_URI,
  });
  if (!body.refresh_token) {
    throw new Error("Google returned no refresh token. Remove the app's prior grant at myaccount.google.com/permissions and reconnect.");
  }
  const tokens: GmailTokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    email: null,
  };
  tokens.email = await fetchAccountEmail(tokens.access_token).catch(() => null);
  saveTokens(tokens);
  return tokens;
}

/** Valid access token, refreshing (and persisting) when within a minute of expiry. */
export async function freshAccessToken(): Promise<string> {
  const t = loadTokens();
  if (!t) throw new Error("Gmail is not connected.");
  if (Date.now() < t.expiresAt - 60_000) return t.access_token;
  const body = await tokenRequest({
    refresh_token: t.refresh_token,
    grant_type: "refresh_token",
  });
  const next: GmailTokens = {
    ...t,
    access_token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  saveTokens(next);
  return next.access_token;
}

async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetchWithTimeout("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const body: any = await res.json().catch(() => ({}));
  return body.emailAddress ?? null;
}

// ---------- Gmail read ----------

async function gmailGet(accessToken: string, path: string): Promise<any> {
  const res = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${body.error?.message ?? "request failed"}`);
  return body;
}

/**
 * Candidate order-confirmation message ids in the lookback window. Gmail's
 * own purchase categorization plus a subject net (exchanges count: a
 * confirmed exchange ships a replacement piece); the LLM still rules on
 * each email, this only bounds how many we read. Paginates — a busy inbox
 * easily exceeds one page, and the first real sync proved a single
 * 25-message page sees only noise.
 */
export async function listOrderMessageIds(
  accessToken: string,
  lookbackDays: number,
  cap = 300,
  skip?: Set<string>,
): Promise<{ ids: string[]; moreRemaining: boolean }> {
  // Gmail's documented any-of syntax is braces; nested `subject:(a OR b)`
  // silently drops matches (the first real backfill missed plain
  // "Order #N confirmed" subjects entirely).
  const q = `newer_than:${lookbackDays}d {category:purchases subject:order subject:receipt subject:confirmation subject:confirmed subject:shipped subject:delivered subject:delivery subject:exchange subject:invoice}`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  let listed = 0;
  do {
    const page = await gmailGet(
      accessToken,
      `messages?q=${encodeURIComponent(q)}&maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
    );
    for (const m of page.messages ?? []) {
      listed++;
      const id = String(m.id);
      // Seen mail doesn't count against the cap: each sync walks deeper
      // into history instead of re-listing the same newest page forever.
      if (skip?.has(id)) continue;
      ids.push(id);
      if (ids.length >= cap) break;
    }
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < cap && listed < 5000);
  return { ids, moreRemaining: ids.length >= cap && pageToken !== undefined };
}

export async function getMessage(accessToken: string, id: string): Promise<any> {
  return gmailGet(accessToken, `messages/${encodeURIComponent(id)}?format=full`);
}

// ---------- MIME → text (pure, unit-tested) ----------

export interface EmailText {
  from: string;
  subject: string;
  receivedAt: string | null; // YYYY-MM-DD
  text: string;
}

function header(payload: any, name: string): string {
  const h = (payload?.headers ?? []).find(
    (x: any) => String(x.name).toLowerCase() === name.toLowerCase(),
  );
  return h ? String(h.value) : "";
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/** Depth-first over MIME parts, collecting bodies of one mime type. */
function collectParts(part: any, mime: string, out: string[]): void {
  if (!part) return;
  if (String(part.mimeType ?? "").toLowerCase() === mime && part.body?.data) {
    out.push(decodeBody(part.body.data));
  }
  for (const p of part.parts ?? []) collectParts(p, mime, out);
}

/**
 * Reduce a Gmail `format=full` message to readable text. Plain-text parts
 * win; HTML-only emails go through the same tag-stripper product pages do.
 * Hard-capped so a mile-long receipt can't blow up the prompt.
 */
export function gmailMessageToText(message: any): EmailText {
  const payload = message?.payload ?? {};
  const plain: string[] = [];
  const html: string[] = [];
  collectParts(payload, "text/plain", plain);
  collectParts(payload, "text/html", html);
  const text = (plain.join("\n").trim() || htmlToText(html.join("\n"))).slice(0, 40_000);

  const dateHeader = header(payload, "date");
  const parsed = dateHeader ? new Date(dateHeader) : null;
  return {
    from: header(payload, "from"),
    subject: header(payload, "subject"),
    receivedAt:
      parsed && !Number.isNaN(parsed.getTime())
        ? parsed.toISOString().slice(0, 10)
        : null,
    text,
  };
}

const ORDER_SUBJECT_MARKERS = [
  "order", "receipt", "confirmation", "confirmed", "shipped", "shipping",
  "delivery", "delivered", "purchase", "invoice", "your package", "exchange",
];

const NOT_ORDER_MARKERS = [
  "cart", "wishlist", "back in stock", "price drop", "sale", "% off",
  "newsletter", "review your", "abandoned",
];

/**
 * Cheap prefilter so marketing blasts don't each cost an LLM call. Errs
 * open: anything that plausibly confirms an order goes through, and the
 * extraction's isApparelOrder verdict is the real judge.
 */
export function looksLikeOrderEmail(subject: string, from: string): boolean {
  const s = subject.toLowerCase();
  const f = from.toLowerCase();
  if (NOT_ORDER_MARKERS.some((m) => s.includes(m))) return false;
  if (ORDER_SUBJECT_MARKERS.some((m) => s.includes(m))) return true;
  return /(orders?|receipts?|noreply|no-reply|store|shop)@/.test(f);
}

// ---------- LLM perception (extraction only, never a write) ----------

const OrderExtractionSchema = z.object({
  isApparelOrder: z
    .boolean()
    .describe("true ONLY if this email confirms clothing, footwear, or fashion accessories (bags, belts, hats, scarves, jewelry) actually purchased or incoming — order confirmations, shipping/delivery notices, and confirmed EXCHANGES (a replacement item shipping counts). Marketing, carts, price alerts, pure returns/refunds, cancellations, and orders of anything else are false."),
  merchant: z.string().nullable().describe("Store/retailer that sent the confirmation, e.g. 'SSENSE'. null if unclear."),
  orderRef: z.string().nullable().describe("Order number/reference exactly as printed. null if absent."),
  orderDate: z.string().nullable().describe("Order date as YYYY-MM-DD if the email states one. null otherwise; never infer."),
  items: z
    .array(
      z.object({
        brand: z.string().nullable().describe("Maker/label of the item, not the store, e.g. 'Rick Owens'. null if the email only names the store."),
        name: z.string().describe("Product name as printed, e.g. 'Geobasket High-Top Sneakers'."),
        category: z
          .enum(["outerwear", "tops", "bottoms", "footwear", "accessories"])
          .nullable()
          .describe("null when the email doesn't make the category clear. Never guess."),
        priceUsd: z.number().nullable().describe("Line-item price in USD. null if absent or in another currency without a stated conversion."),
        sizeLabel: z.string().nullable().describe("Ordered size as printed ('L', '33', 'US 10'). null if absent."),
        colors: z.array(z.string()).describe("Colorway of this line item as stated, lowercase. Empty if not stated."),
        materials: z.array(z.string()).describe("Materials ONLY if the email states them (rare). Empty otherwise; never guess."),
      }),
    )
    .describe("One entry per apparel line item. Empty when isApparelOrder is false."),
  confidence: z.enum(["high", "medium", "low"]),
});

export type OrderExtraction = z.infer<typeof OrderExtractionSchema>;

export async function extractOrderEmail(email: EmailText): Promise<OrderExtraction> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system:
      "You extract structured order data from e-commerce emails. " +
      "Report only what the email states. Never infer brands, prices, sizes, materials, or dates that are not present: " +
      "null and empty arrays are correct answers for absent data. You only extract; you never decide what happens to the data.",
    messages: [
      {
        role: "user",
        content: `From: ${email.from}\nSubject: ${email.subject}\nDate: ${email.receivedAt ?? "unknown"}\n\n${email.text}`,
      },
    ],
    output_config: { format: zodOutputFormat(OrderExtractionSchema) },
  });
  const extraction = response.parsed_output;
  if (!extraction) throw new Error("Order extraction failed to parse.");
  return extraction;
}

// ---------- proposals (quarantine between perception and the vault) ----------

// Proposal confirmation is a read-modify-write across the proposals file,
// inventory, and the ledger. Serialize it — mirrors quests.ts's
// withQuestsLock — so two concurrent confirms of the same proposal can't
// both pass the "still proposed" check and each write a duplicate item.
let ingestChain: Promise<unknown> = Promise.resolve();

export function withIngestLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = ingestChain.then(fn, fn);
  ingestChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function loadProposals(): IngestProposal[] {
  return readJson<IngestProposal[]>(PROPOSALS_FILE, []);
}

export function saveProposals(proposals: IngestProposal[]): void {
  writeJson(PROPOSALS_FILE, proposals);
}

/** messageId → what happened, so re-syncs never re-read or re-propose. */
export function loadSeen(): Record<string, { at: string; outcome: string }> {
  return readJson<Record<string, { at: string; outcome: string }>>(SEEN_FILE, {});
}

export function saveSeen(seen: Record<string, { at: string; outcome: string }>): void {
  writeJson(SEEN_FILE, seen);
}

/** Pure: extraction + provenance → proposal records (no id, no writes). */
export function proposalsFromExtraction(
  extraction: OrderExtraction,
  source: IngestProposal["source"],
  profileId: string,
  now: Date = new Date(),
): Omit<IngestProposal, "id">[] {
  if (!extraction.isApparelOrder) return [];
  return extraction.items
    .filter((it) => it.name.trim().length > 0)
    .map((it) => ({
      profileId,
      at: now.toISOString(),
      source,
      merchant: extraction.merchant,
      orderRef: extraction.orderRef,
      orderDate: extraction.orderDate,
      item: {
        brand: it.brand,
        name: it.name,
        category: it.category as Category | null,
        priceUsd: it.priceUsd,
        sizeLabel: it.sizeLabel,
        colors: it.colors.map((c) => c.toLowerCase()),
        materials: it.materials.map((m) => m.toLowerCase()),
      },
      confidence: extraction.confidence,
      status: "proposed" as const,
    }));
}

/** The owner's edits at confirm time. Category is the one hard requirement. */
export interface ConfirmOverrides {
  category?: string;
  brand?: string;
  name?: string;
  priceUsd?: number | null;
  materials?: string[];
  recordSpend?: boolean;
}

/**
 * Pure conversion of a confirmed proposal into the exact vault item and
 * (optional) ledger entry the server will write. Plain code, fully
 * unit-tested: this is the only doorway from perception into state, and
 * the LLM is not in it.
 */
export function proposalToItem(
  p: IngestProposal,
  overrides: ConfirmOverrides,
  protocols: CareProtocol[],
): {
  item: Omit<Item, "id">;
  ledger: Omit<LedgerEntry, "id"> | null;
} {
  const category = (overrides.category ?? p.item.category) as Category | null;
  if (!category || !CATEGORIES.includes(category)) {
    throw new Error("A category is required to commit a piece to the vault.");
  }
  const name = (overrides.name ?? p.item.name).trim();
  if (!name) throw new Error("A name is required.");
  const brand = (overrides.brand ?? p.item.brand ?? p.merchant ?? "").trim();
  if (!brand) throw new Error("A brand is required.");
  const priceRaw = overrides.priceUsd !== undefined ? overrides.priceUsd : p.item.priceUsd;
  if (typeof priceRaw === "number" && (!Number.isFinite(priceRaw) || priceRaw < 0)) {
    throw new Error("Price must be a non-negative finite number.");
  }
  const priceUsd = typeof priceRaw === "number" && Number.isFinite(priceRaw) ? priceRaw : undefined;
  const materials = (overrides.materials ?? p.item.materials).map((m) => m.toLowerCase()).filter(Boolean);

  const item: Omit<Item, "id"> = {
    profileId: p.profileId,
    category,
    brand,
    name,
    materials,
    colors: p.item.colors,
    sizeLabel: p.item.sizeLabel ?? undefined,
    priceUsd,
    acquiredAt: p.orderDate ?? p.source.receivedAt ?? undefined,
    wearCount: 0,
    careProtocolIds: assignProtocols(materials, protocols),
    notes: `Ingested from ${p.merchant ?? "order email"}${p.orderRef ? ` (order ${p.orderRef})` : ""}`,
  };

  const ledger: Omit<LedgerEntry, "id"> | null =
    overrides.recordSpend && priceUsd !== undefined
      ? {
          profileId: p.profileId,
          date: item.acquiredAt ?? new Date().toISOString().slice(0, 10),
          description: `${brand}, ${name}`,
          brand,
          platform: p.merchant ?? undefined,
          amountUsd: priceUsd,
          cleared: true,
        }
      : null;

  return { item, ledger };
}

// ---------- sync orchestration ----------

export interface SyncReport {
  scanned: number;
  skippedPrefilter: number;
  notApparel: number;
  proposed: number;
  /** duplicate line items collapsed (same merchant + order ref + item, e.g. a thread of "Re:" order mails) */
  duplicates: number;
  /** true when the email cap was hit with matches still unlisted: no silent truncation, run sync again to go deeper */
  moreRemaining: boolean;
  /** true when the LLM daily cap ran out mid-sync; unprocessed emails stay unseen for the next pass */
  capReached: boolean;
  failures: { messageId: string; error: string }[];
}

/**
 * One proposal per real-world line item: an order that arrives as an email
 * thread must not multiply. Key is merchant + orderRef + item name; without
 * an order ref two same-name proposals are kept (they may be real repeats).
 */
export function proposalDupKey(p: {
  merchant: string | null;
  orderRef: string | null;
  item: { name: string };
}): string | null {
  if (!p.orderRef) return null;
  return `${(p.merchant ?? "").toLowerCase()}|${p.orderRef.toLowerCase()}|${p.item.name.toLowerCase()}`;
}

/**
 * One sync pass: list candidate emails, skip everything seen, prefilter,
 * extract, quarantine proposals. Sequential like quest batch-adds — the
 * LLM is the slow step and one-at-a-time keeps server load flat.
 */
export async function syncOrders(
  profileId: string,
  lookbackDays = 60,
  maxEmails = 300,
): Promise<SyncReport> {
  const accessToken = await freshAccessToken();
  const seen = loadSeen();
  const { ids, moreRemaining } = await listOrderMessageIds(
    accessToken,
    lookbackDays,
    maxEmails,
    new Set(Object.keys(seen)),
  );
  const report: SyncReport = {
    scanned: 0, skippedPrefilter: 0, notApparel: 0, proposed: 0,
    duplicates: 0, moreRemaining, capReached: false, failures: [],
  };

  for (const id of ids) {
    if (seen[id]) continue;
    report.scanned++;
    try {
      // Re-resolved per message: a long sync outlives Google's ~1h access
      // token (the first deep backfill 401'd halfway), and this returns the
      // cached token until a minute before expiry, then refreshes.
      const message = await getMessage(await freshAccessToken(), id);
      const email = gmailMessageToText(message);
      if (!looksLikeOrderEmail(email.subject, email.from) || !email.text.trim()) {
        seen[id] = { at: new Date().toISOString(), outcome: "skipped-prefilter" };
        report.skippedPrefilter++;
        continue;
      }
      // Each extraction is one real LLM call: charge the daily cap here,
      // per email, so a 500-email sync costs 500 — not the route's entry
      // ticket. The unprocessed remainder stays unseen for the next pass.
      if (!spendLlm(currentUserId(), 1).allowed) {
        report.capReached = true;
        break;
      }
      const extraction = await extractOrderEmail(email);
      const proposals = proposalsFromExtraction(extraction, {
        messageId: id,
        from: email.from,
        subject: email.subject,
        receivedAt: email.receivedAt,
      }, profileId);
      if (!proposals.length) {
        seen[id] = { at: new Date().toISOString(), outcome: "not-apparel" };
        report.notApparel++;
        continue;
      }
      const all = loadProposals();
      const known = new Set(all.map(proposalDupKey).filter(Boolean) as string[]);
      let added = 0;
      for (const p of proposals) {
        const key = proposalDupKey(p);
        if (key && known.has(key)) { report.duplicates++; continue; }
        if (key) known.add(key);
        all.push({ ...p, id: newId("ing") });
        added++;
      }
      saveProposals(all);
      seen[id] = { at: new Date().toISOString(), outcome: added ? `proposed-${added}` : "duplicate-order" };
      report.proposed += added;
    } catch (e) {
      report.failures.push({ messageId: id, error: String((e as Error).message) });
    } finally {
      saveSeen(seen);
    }
  }
  return report;
}
