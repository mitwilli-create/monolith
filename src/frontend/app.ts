// MONOLITH frontend: vanilla TS, no framework. Four surfaces:
// VERDICT (purchase verdicts + quests — one link is a verdict, several are
// a comparison), SIZE, VAULT (inventory + care/upkeep), CAPITAL (budget).

type Tab = "verdict" | "size" | "vault" | "capital";

interface Finding { code: string; message: string; source: string }
interface GateResult { gate: string; name: string; passed: boolean; violations: Finding[]; notes: Finding[] }
interface Verdict {
  id: string; at: string; decision: "APPROVE" | "REJECT" | "INSUFFICIENT_DATA";
  missingData: string[];
  candidate: { brand: string; name: string; category: string; priceUsd: number | null; materials: string[]; fitDescriptors: string[]; descriptionText: string; platform?: string; url?: string };
  gates: GateResult[];
  sizing: { recommendation: string; rationale: string; source: string; fallback: boolean };
  budget: { month: string; spentUsd: number; budgetUsd: number; remainingUsd: number; overBudgetIfPurchased: boolean };
  careCommitment: string[];
  // Optional: historical verdicts in the audit log predate this field.
  costProjection?: { projectedCostPerWear: number | null; wearSample: number; medianWears: number | null };
}

const view = document.getElementById("view")!;
const budgetStrip = document.getElementById("budget-strip")!;
let currentTab: Tab = "verdict";
let profile: any = null;
let extractionAvailable = false;

// ---------- utilities ----------

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.unauthenticated) {
    // Session expired mid-use: reboot into the sign-in gate.
    location.reload();
    throw new Error("Signed out.");
  }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return body as T;
}

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

function toast(msg: string): void {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

/** Programmatic tab switch, used by the budget strip, verdict links, etc. */
function switchTab(tab: Tab): void {
  const btn = document.querySelector<HTMLButtonElement>(`#tabbar button[data-tab="${tab}"]`);
  btn?.click();
}

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function monthLabel(ym: string): string {
  const m = Number.parseInt(ym.slice(5, 7), 10);
  return MONTHS[m - 1] ?? ym;
}

async function refreshBudgetStrip(): Promise<void> {
  try {
    const b = await api("/api/budget");
    const s = b.status;
    // Short enough never to wrap at 375px; the full story lives on CAPITAL.
    budgetStrip.textContent =
      s.remainingUsd < 0
        ? `${monthLabel(s.month)} · OVER ${usd(-s.remainingUsd)}`
        : `${monthLabel(s.month)} · ${usd(s.remainingUsd)} / ${usd(s.budgetUsd)}`;
    budgetStrip.classList.toggle("over", s.remainingUsd < 0);
  } catch { budgetStrip.textContent = "–"; }
}

budgetStrip.addEventListener("click", () => switchTab("capital"));

// The wordmark is the universal way home: VERDICT, from anywhere.
document.querySelector<HTMLElement>("#topbar .wordmark")?.addEventListener("click", () => switchTab("verdict"));

// ---------- verdict rendering ----------

function findingHtml(f: Finding, cls: string): string {
  const good = f.code === "MATERIAL_PREFERRED" || f.code === "DOCTRINE_ALIGNED" || f.code === "BUDGET_CLEAR";
  return `<div class="finding ${good ? "good" : cls}">${esc(f.message)}<span class="src">${esc(f.source)}</span></div>`;
}

async function recordPurchase(v: Verdict, override: boolean): Promise<void> {
  const c = v.candidate;
  const inv = await api("/api/inventory", {
    method: "POST",
    body: JSON.stringify({
      brand: c.brand, name: c.name, category: c.category,
      materials: c.materials, priceUsd: c.priceUsd ?? undefined,
      acquiredAt: new Date().toISOString().slice(0, 10),
      notes: override ? `Recorded over a REJECTED verdict (${v.id})` : undefined,
    }),
  });
  if (c.priceUsd !== null) {
    await api("/api/ledger", {
      method: "POST",
      body: JSON.stringify({
        description: `${override ? "OVERRIDE: " : ""}${c.brand}, ${c.name}`,
        brand: c.brand, platform: c.platform,
        amountUsd: c.priceUsd, cleared: true, itemId: inv.item.id,
      }),
    });
  }
  refreshBudgetStrip();
}

/**
 * One-shot record buttons: disable the whole action block on first tap and
 * replace it with a persistent confirmation on success. A second tap can
 * never double-write the ledger or the vault.
 */
function wireRecordAction(card: HTMLElement, selector: string, v: Verdict, override: boolean): void {
  const btn = card.querySelector<HTMLButtonElement>(selector);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const block = btn.closest(".block") as HTMLElement;
    block.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    btn.textContent = "RECORDING…";
    try {
      await recordPurchase(v, override);
      block.innerHTML = `
        <div class="recorded-state">RECORDED ✓: ${usd(v.candidate.priceUsd)} TO LEDGER, PIECE TO VAULT${override ? " (MARKED AS OVERRIDE)" : ""}</div>`;
      const link = el(`<button class="ghost" type="button">VIEW IN VAULT</button>`);
      link.addEventListener("click", () => switchTab("vault"));
      block.appendChild(link);
    } catch (e) {
      toast(String((e as Error).message));
      block.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = false));
      btn.textContent = override ? "OVERRIDE: RECORD ANYWAY" : "RECORD PURCHASE";
    }
  });
}

/**
 * The celebrated yes. An APPROVE cleared money, climate, and doctrine — the
 * hardest thing to find is a purchase you won't second-guess, and this is one.
 * The affirmation and the cost-per-wear payoff are composed by code from the
 * verdict's own numbers, so the feeling is earned, not manufactured.
 */
function celebratedYesHtml(v: Verdict): string {
  const c = v.candidate;
  const cpw = v.costProjection?.projectedCostPerWear ?? null;
  const underBudget = c.priceUsd !== null && !v.budget.overBudgetIfPurchased;

  const lines: string[] = [
    "Every gate cleared — money, climate, and your doctrine. This is a buy you won't have to talk yourself into.",
  ];
  if (underBudget && c.priceUsd !== null) {
    lines.push(`It sits inside your month: ${usd(v.budget.remainingUsd - c.priceUsd)} still yours afterward.`);
  }

  const cpwBlock =
    cpw !== null
      ? `<div class="cpw">
           <div class="cpw-num">${usd(cpw)}<span class="cpw-unit"> / wear</span></div>
           <div class="cpw-note">projected against the ${esc(c.category)} you actually reach for (median ${esc(v.costProjection!.medianWears)} wears across ${esc(v.costProjection!.wearSample)} piece${v.costProjection!.wearSample === 1 ? "" : "s"} in your vault). Worn like the rest, it earns its place.<span class="src">your vault · src/quests.ts projection</span></div>
         </div>`
      : `<div class="cpw"><div class="cpw-note">Log a few wears on your ${esc(c.category)} in VAULT and the next yes will show what this piece would truly cost per wear.</div></div>`;

  return `
    <div class="block yes-hero">
      <div class="yes-mark">YES — THIS ONE</div>
      <div class="yes-line">${lines.map((l) => esc(l)).join(" ")}</div>
      ${cpwBlock}
    </div>`;
}

function renderVerdict(v: Verdict): HTMLElement {
  const cls = v.decision === "APPROVE" ? "approve" : v.decision === "REJECT" ? "reject" : "insufficient";
  const head = v.decision === "APPROVE" ? "APPROVED" : v.decision === "REJECT" ? "REJECTED" : "INSUFFICIENT DATA";

  // Each check renders with its own reasons directly beneath it. A FAIL is
  // never separated from its why.
  const gateBlocks = v.gates.map((g) => `
    <div class="block">
      <div class="gate-line"><span class="status ${g.passed ? "pass" : "fail"}">${g.passed ? "PASS" : "FAIL"}</span><span>GATE ${g.gate} · ${esc(g.name)}</span></div>
      ${g.violations.map((f) => findingHtml(f, "violation")).join("")}
      ${g.notes.map((f) => findingHtml(f, "note")).join("")}
    </div>`).join("");

  const missing = v.missingData.length
    ? `<div class="block"><h4>MISSING DATA: VERIFY BEFORE BUYING</h4>${v.missingData.map((m) => `<div class="finding note">${esc(m)}</div>`).join("")}</div>`
    : "";
  const care = v.careCommitment.length
    ? `<div class="block"><h4>IF ACQUIRED: CARE THIS COMMITS YOU TO</h4>${v.careCommitment.map((c) => `<div class="finding note">${esc(c)}</div>`).join("")}</div>`
    : "";
  const post = v.candidate.priceUsd !== null && v.decision === "APPROVE"
    ? ` · post-purchase ${usd(v.budget.remainingUsd - v.candidate.priceUsd)}`
    : "";

  // The celebrated yes: an APPROVE is not a permission slip, it is the reward.
  // Every line here is composed by code from the verdict's own evidence — the
  // three gates it cleared, its projected cost-per-wear, its budget headroom —
  // so the excitement is earned and honest, never hype.
  const yesHero = v.decision === "APPROVE" ? celebratedYesHtml(v) : "";

  const actions =
    v.decision === "APPROVE"
      ? `<div class="block">
          <div class="finding note">Nothing is saved until you say so. This writes the piece to your wardrobe (VAULT) and its price to your ledger (CAPITAL).</div>
          <button class="cta" data-record>MAKE IT YOURS · RECORD IT</button>
        </div>`
      : v.decision === "REJECT"
        ? `<div class="block">
            <div class="finding note">Disagree? Overriding records the purchase anyway and marks the entry as an override. The record stays honest.</div>
            <button class="ghost" data-override>OVERRIDE: RECORD ANYWAY</button>
            <button class="ghost" data-dismiss>DISMISS VERDICT</button>
          </div>`
        : `<div class="block">
            <div class="finding note">Fill in the missing fields under MANUAL ENTRY above and run the checks again.</div>
          </div>`;

  const card = el(`
    <div class="verdict ${cls}">
      <div class="head">${head}</div>
      <div class="sub">${esc(v.candidate.brand)}, ${esc(v.candidate.name)} · ${esc(v.candidate.category)} · ${usd(v.candidate.priceUsd)}</div>
      ${yesHero}
      ${gateBlocks}
      ${missing}
      <div class="block"><h4>ORDER THIS SIZE${v.sizing.fallback ? " (BASELINE: NO BRAND RULE ON FILE)" : ""}</h4>
        <div class="finding note"><strong style="color:var(--ink)">${esc(v.sizing.recommendation)}</strong><br>${esc(v.sizing.rationale)}<span class="src">${esc(v.sizing.source)}</span></div>
      </div>
      <div class="block"><h4>BUDGET POSITION</h4>
        <div class="finding note">${v.budget.month}: ${usd(v.budget.spentUsd)} spent of ${usd(v.budget.budgetUsd)} · ${usd(v.budget.remainingUsd)} left${post}</div>
        <button class="mini" type="button" data-open-capital>OPEN CAPITAL</button>
      </div>
      ${care}
      ${actions}
    </div>`);

  card.querySelector("[data-open-capital]")?.addEventListener("click", () => switchTab("capital"));

  wireRecordAction(card, "[data-record]", v, false);
  wireRecordAction(card, "[data-override]", v, true);
  card.querySelector("[data-dismiss]")?.addEventListener("click", () => card.remove());

  return card;
}

// ---------- VERDICT surface · the point of temptation ----------
// GATE and DECIDE, fused. One link is a purchase verdict; several links
// (one per line) are contenders in a quest. The same three gates run per
// item either way — the mode is only how many links you paste.

/** Links pasted on the verdict box, staged until a quest opens to hold them. */
let pendingUrls: string[] | null = null;

function parseUrlLines(raw: string): string[] {
  return [...new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean))];
}

function fillManual(c: Verdict["candidate"]): void {
  (document.getElementById("g-manual") as HTMLDetailsElement).open = true;
  (document.getElementById("m-brand") as HTMLInputElement).value = c.brand;
  (document.getElementById("m-name") as HTMLInputElement).value = c.name;
  (document.getElementById("m-cat") as HTMLSelectElement).value = c.category;
  (document.getElementById("m-price") as HTMLInputElement).value = c.priceUsd === null ? "" : String(c.priceUsd);
  (document.getElementById("m-platform") as HTMLInputElement).value = c.platform ?? "";
  (document.getElementById("m-materials") as HTMLInputElement).value = c.materials.join(", ");
  (document.getElementById("m-fit") as HTMLInputElement).value = c.fitDescriptors.join(", ");
  (document.getElementById("m-desc") as HTMLTextAreaElement).value = c.descriptionText;
}

function manualCandidate(url?: string) {
  const num = Number.parseFloat((document.getElementById("m-price") as HTMLInputElement).value);
  return {
    url,
    brand: (document.getElementById("m-brand") as HTMLInputElement).value,
    name: (document.getElementById("m-name") as HTMLInputElement).value,
    category: (document.getElementById("m-cat") as HTMLSelectElement).value,
    priceUsd: Number.isFinite(num) ? num : null,
    platform: (document.getElementById("m-platform") as HTMLInputElement).value || undefined,
    materials: splitCsv((document.getElementById("m-materials") as HTMLInputElement).value),
    fitDescriptors: splitCsv((document.getElementById("m-fit") as HTMLInputElement).value),
    descriptionText: (document.getElementById("m-desc") as HTMLTextAreaElement).value,
  };
}

async function runOnCandidate(candidate: unknown): Promise<void> {
  const r = await api("/api/verdict", { method: "POST", body: JSON.stringify(candidate) });
  const result = document.getElementById("g-result")!;
  result.innerHTML = "";
  result.appendChild(renderVerdict(r.verdict));
  loadHistory();
  refreshBudgetStrip();
}

async function loadHistory(): Promise<void> {
  try {
    const h = await api("/api/verdicts?limit=25");
    const box = document.getElementById("g-history");
    if (!box || !h.verdicts.length) return;

    // Re-running the same item appends a new record; collapse consecutive
    // identical rows into one with a ×N count so history stays readable.
    const groups: { v: Verdict; count: number }[] = [];
    for (const v of h.verdicts as Verdict[]) {
      const prev = groups[groups.length - 1];
      const key = (x: Verdict) =>
        `${x.candidate.brand}|${x.candidate.name}|${x.candidate.priceUsd}|${x.decision}`;
      if (prev && key(prev.v) === key(v)) prev.count++;
      else groups.push({ v, count: 1 });
    }

    box.innerHTML = groups.slice(0, 10).map(({ v, count }, i) => `
      <div class="item-row" data-hist="${i}" role="button" tabindex="0" style="cursor:pointer">
        <div>
          <div class="title">${esc(v.candidate.brand)}, ${esc(v.candidate.name)}${count > 1 ? ` <span class="mono" style="font-size:10px;color:var(--dim)">×${count}</span>` : ""}</div>
          <div class="meta">${v.at.slice(0, 10)} · ${usd(v.candidate.priceUsd)} · tap to reopen the full verdict</div>
        </div>
        <span class="mono" style="color:var(--ink);font-weight:${v.decision === "REJECT" ? "700" : "400"};font-size:10px;letter-spacing:.14em;${v.decision === "REJECT" ? "text-decoration:underline" : ""}">${v.decision === "APPROVE" ? "+ APPROVED" : v.decision === "REJECT" ? "✕ REJECTED" : "◌ INSUFFICIENT"}</span>
      </div>`).join("");

    box.querySelectorAll<HTMLElement>("[data-hist]").forEach((row) => {
      const open = () => {
        const g = groups[Number(row.dataset.hist)];
        if (!g) return;
        const result = document.getElementById("g-result")!;
        result.innerHTML = "";
        result.appendChild(renderVerdict(g.v));
        result.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") open(); });
    });
  } catch { /* history is non-critical */ }
}

/** The note shown inside START A QUEST while links wait to become contenders. */
function queuedNoteHtml(): string {
  return pendingUrls?.length
    ? `<div class="finding good">${pendingUrls.length} LINKS QUEUED FROM THE VERDICT BOX. OPEN THE QUEST AND THEY BECOME ITS FIRST CONTENDERS.</div>`
    : "";
}

function verdictInputEl(): HTMLElement {
  const wrap = el(`
    <div>
      <h2 class="section">SHOULD I BUY THIS?</h2>
      <div class="panel">
        <div class="muted" style="margin-bottom:14px">One link: the item is read automatically, then three gates run before you buy, named exactly as they appear on the verdict — GATE A (budget + inventory), GATE B (climate + materials), GATE C (aesthetic). Each is a pass/fail rule set built from your profile. Several links, one per line: they become contenders in a quest below, and the same gates rank them against each other.</div>
        <label>Product links · one per line</label>
        <textarea id="g-urls" rows="2" inputmode="url" placeholder="https://…" autocomplete="off"></textarea>
        <button class="cta" id="g-run">RUN THE GATES</button>
        ${extractionAvailable ? "" : `<div class="muted" style="margin-top:8px">Automatic reading is offline (no API key). Use manual entry below.</div>`}
        <details class="manual" id="g-manual">
          <summary>MANUAL ENTRY</summary>
          <div class="muted" style="margin-bottom:12px">Use this when a link can't be read automatically, or to correct what was read. Both paths run the same three gates.</div>
          <div class="row2">
            <div><label>Brand</label><input id="m-brand" placeholder="e.g. Rick Owens" /></div>
            <div><label>Category</label>
              <select id="m-cat">
                <option>outerwear</option><option>tops</option><option>bottoms</option>
                <option>footwear</option><option>accessories</option>
              </select>
            </div>
          </div>
          <label>Product name</label><input id="m-name" placeholder="e.g. Creatch Cargo Pants" />
          <div class="row2">
            <div><label>Price USD</label><input id="m-price" type="number" inputmode="decimal" /></div>
            <div><label>Store / platform</label><input id="m-platform" placeholder="e.g. Farfetch" /></div>
          </div>
          <label>Materials (comma-separated)</label><input id="m-materials" placeholder="e.g. waxed cotton, calfskin leather" />
          <label>Fit wording from the listing (comma-separated)</label><input id="m-fit" placeholder="e.g. oversized, slim fit" />
          <label>Description</label><textarea id="m-desc" rows="3" placeholder="Paste or summarize the product description"></textarea>
          <button class="ghost" id="m-run">RUN THE GATES</button>
        </details>
      </div>
      <div id="g-result"></div>
    </div>`);

  const urlBox = wrap.querySelector("#g-urls") as HTMLTextAreaElement;
  const runBtn = wrap.querySelector("#g-run") as HTMLButtonElement;

  // The mode is the URL count; the button always says which door it opens.
  const syncRunLabel = () => {
    const n = parseUrlLines(urlBox.value).length;
    runBtn.textContent = n > 1 ? `COMPARE ${n} · OPEN A QUEST` : "RUN THE GATES";
  };
  urlBox.addEventListener("input", () => {
    syncRunLabel();
    // Editing the box after staging invalidates the stage: a quest opened
    // later must never silently inherit a stale, no-longer-visible set of URLs.
    if (pendingUrls !== null) {
      pendingUrls = null;
      const note = document.getElementById("q-queued");
      if (note) note.innerHTML = queuedNoteHtml();
    }
  });

  runBtn.addEventListener("click", async () => {
    const urls = parseUrlLines(urlBox.value);
    if (!urls.length) { toast("PASTE A LINK, OR USE MANUAL ENTRY."); return; }

    if (urls.length > 1) {
      // Several contenders means a quest. Stage the links and walk the user
      // to the quest form; OPEN THE QUEST attaches them as contenders.
      pendingUrls = urls;
      const note = document.getElementById("q-queued");
      if (note) note.innerHTML = queuedNoteHtml();
      document.getElementById("q-start")?.scrollIntoView({ behavior: "smooth", block: "start" });
      (document.getElementById("q-title") as HTMLInputElement | null)?.focus({ preventScroll: true });
      return;
    }

    const url = urls[0]!;
    runBtn.disabled = true; runBtn.textContent = "READING THE LISTING…";
    try {
      const ex = await api("/api/extract", { method: "POST", body: JSON.stringify({ url }) });
      fillManual(ex.candidate);
      if (ex.extraction.missing?.length) toast(`UNVERIFIED FIELDS: ${ex.extraction.missing.join(", ")}`);
      runBtn.textContent = "RUNNING THE GATES…";
      await runOnCandidate({ ...ex.candidate, url });
    } catch (e) {
      toast(String((e as Error).message));
      (document.getElementById("g-manual") as HTMLDetailsElement).open = true;
    } finally {
      runBtn.disabled = false;
      syncRunLabel();
    }
  });

  wrap.querySelector("#m-run")!.addEventListener("click", async () => {
    try {
      await runOnCandidate(manualCandidate(parseUrlLines(urlBox.value)[0]));
    } catch (e) { toast(String((e as Error).message)); }
  });

  return wrap;
}

function historyEl(): HTMLElement {
  return el(`
    <div>
      <h2 class="section">RECENT VERDICTS · NEWEST FIRST</h2>
      <div class="panel" id="g-history"><div class="empty">NO VERDICTS YET. RUN YOUR FIRST ITEM ABOVE</div></div>
    </div>`);
}

// Read-only view of every rule the gates cite (#25, the sources verdicts
// reference must be inspectable somewhere).
function rulesOnFileHtml(): string {
  const a = profile?.aesthetic;
  const mr = profile?.materialRules;
  if (!a || !mr) return "";
  const list = (items: string[]) => items.map((x: string) => `<div class="finding note">${esc(x)}</div>`).join("");
  const matRules = (rules: any[], label: string) =>
    rules.length
      ? `<div style="margin-top:10px"><label>${label}</label>${rules.map((r: any) =>
          `<div class="finding note">${esc(r.match.join(", "))}${r.unless?.length ? ` (unless ${esc(r.unless.join(", "))})` : ""}: ${esc(r.reason)}</div>`).join("")}</div>`
      : "";
  return `
    <details class="manual" style="margin-top:18px">
      <summary>THE RULES ON FILE: WHAT VERDICTS CITE</summary>
      <div class="muted" style="margin:10px 0 12px">Read-only. These live in your profile (data/profiles.json on the server) and drive every gate.</div>
      <label>Aesthetic doctrine</label>
      <div class="finding note">${esc(a.doctrine)}</div>
      <div style="margin-top:10px"><label>Doctrine signals (credited when present)</label>${list(a.approvedSignals)}</div>
      <div style="margin-top:10px"><label>Banned aesthetics</label>${a.bannedAesthetics.map((b: any) => `<div class="finding note">${esc(b.label)} (markers: ${esc(b.markers.join(", "))})</div>`).join("")}</div>
      <div style="margin-top:10px"><label>Banned brands</label>${list(a.bannedBrands)}</div>
      <div style="margin-top:10px"><label>Banned fit terms</label>${list(a.bannedFitTerms)}</div>
      ${matRules(mr.banned, "Materials (banned)")}
      ${matRules(mr.flagged, "Materials (flagged, warning only)")}
      ${matRules(mr.preferred, "Materials (preferred)")}
    </details>`;
}

function splitCsv(s: string): string[] {
  return s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

// ---------- quests · the comparison half of the VERDICT surface ----------

/** Which quest's detail view is open; null = the quest list. */
let openQuestId: string | null = null;

/** Result of the last batch link-add, kept visible across re-renders so love
 *  clicks etc. don't wipe the failure list; cleared on quest switch. */
let batchReport: { questId: string; added: number; failures: { url: string; error: string }[] } | null = null;

/**
 * Read a batch of listings and add each as a quest contender. Sequential on
 * purpose: extraction is the slow step, and one-at-a-time keeps the progress
 * label honest and the server load flat.
 */
async function batchAddUrls(
  questId: string,
  category: string,
  urls: string[],
  progress: (label: string) => void,
): Promise<{ added: number; failures: { url: string; error: string }[] }> {
  const failures: { url: string; error: string }[] = [];
  let added = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    progress(`READING ${i + 1}/${urls.length}…`);
    if (!/^https?:\/\//i.test(url)) {
      failures.push({ url, error: "not an http(s) link" });
      continue;
    }
    try {
      const ex = await api("/api/extract", { method: "POST", body: JSON.stringify({ url }) });
      await api(`/api/quests/${questId}/candidates`, {
        method: "POST",
        body: JSON.stringify({ ...ex.candidate, url, category }),
      });
      added++;
    } catch (e) {
      failures.push({ url, error: String((e as Error).message) });
    }
  }
  return { added, failures };
}

/** Mirrors loveCeiling in src/quests.ts for display; the server holds authority. */
function loveCeilingUsd(q: any, love?: number): number {
  return q.targetUsd + (q.stretchUsd - q.targetUsd) * (((love ?? 1) - 1) / 4);
}

function loveButtonsHtml(qc: any): string {
  return `<span class="mono" style="font-size:10px;letter-spacing:.05em">LOVE</span> ` +
    [1, 2, 3, 4, 5].map((n) =>
      `<button class="mini" data-love="${n}" data-love-cand="${esc(qc.id)}" style="${qc.love === n ? "background:var(--ink);color:var(--bg)" : ""}">${n}</button>`,
    ).join("");
}

/**
 * The eye is the fallback for pages text can't reach, and it is only offered
 * there: rows whose listing is mute on style (no descriptors extracted, no
 * doctrine hits), plus every row of an accessories quest — bag and accessory
 * pages describe hardware and capacity, never doctrine, so the owner's
 * looked-at-it verdict is the only aesthetic evidence there is. Rows whose
 * listing carries real style language keep the text path and get no buttons
 * (same pattern as CHOOSE appearing only on gate-passed rows). A declared
 * eye always stays visible so it can be cleared. The engine honors a
 * declared eye regardless; this scopes only who is offered the buttons.
 */
function eyeApplies(quest: any, qc: any): boolean {
  return (
    quest.category === "accessories" ||
    qc.eye === "on" || qc.eye === "off" ||
    qc.score?.aestheticFit?.evidence === false
  );
}

/**
 * The eye: your looked-at-it verdict on the aesthetic axis. Tap the active
 * one again to clear it and fall back to listing-text evidence.
 */
function eyeButtonsHtml(qc: any): string {
  const btn = (v: "on" | "off", label: string) =>
    `<button class="mini" data-eye="${v}" data-eye-cand="${esc(qc.id)}" title="Your declared aesthetic verdict; tap again to clear" style="${qc.eye === v ? "background:var(--ink);color:var(--bg)" : ""}">${label}</button>`;
  return `<span class="mono" style="font-size:10px;letter-spacing:.05em">THE EYE</span> ${btn("on", "ON DOCTRINE")}${btn("off", "OFF")}`;
}

/** Clickable suggestions that append canonical, matcher-friendly terms. */
const REQUIREMENT_CHIPS: Record<string, string[]> = {
  accessories: ["leather", "tote", "black", "laptop compartment", "crossbody strap", "backpack straps", "top handle", "zip closure", "convertible carry"],
  footwear: ["leather", "black", "goodyear welt", "side zip", "waterproof", "lug sole"],
  outerwear: ["waxed cotton", "wool", "black", "hood", "waterproof"],
  tops: ["black", "wool", "cotton", "boxy"],
  bottoms: ["black", "wool", "heavy cotton twill", "wide leg"],
};
const MUST_NOT_CHIPS = ["visible logo", "suede", "polyester", "slim fit"];

function chipRowHtml(targetInputId: string, terms: string[]): string {
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin:-4px 0 10px">${terms
    .map((t) => `<button class="mini" data-chip-for="${esc(targetInputId)}" data-chip="${esc(t)}">+ ${esc(t)}</button>`)
    .join("")}</div>`;
}

/**
 * Chip click appends its term to the target CSV input (once). `scope` bounds
 * which buttons get wired (so a re-rendered chip row never re-wires its
 * siblings); `root` is where the target inputs live.
 */
function wireChips(scope: HTMLElement, root: HTMLElement = scope): void {
  scope.querySelectorAll<HTMLButtonElement>("[data-chip-for]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = root.querySelector(`#${btn.dataset.chipFor}`) as HTMLInputElement | null;
      if (!input) return;
      const terms = splitCsv(input.value);
      if (!terms.includes(btn.dataset.chip!)) input.value = [...terms, btn.dataset.chip!].join(", ");
    });
  });
}

function scoreBreakdownHtml(qc: any, quest: any): string {
  const s = qc.score;
  const list = (label: string, xs: string[]) =>
    xs.length ? `<div class="finding note">${label}: ${esc(xs.join(", "))}</div>` : "";
  const aesNote = s.aestheticFit.declared
    ? `<div class="finding note">Aesthetic ${s.aestheticFit.score} declared by your eye (${s.aestheticFit.declared === "on" ? "on" : "off"} doctrine). Listing text not consulted; tap the active eye button to return to text evidence.</div>`
    : s.aestheticFit.evidence === false
      ? `<div class="finding note">The listing says nothing about its own style (no descriptors extracted, no doctrine hits): not counted against it, composite reweighted to need + budget. Doctrine signals live in your profile (VERDICT tab → rules on file). Your eye beats a mute page: declare ON/OFF DOCTRINE above after looking at the photos.</div>`
      : "";
  const cpw = s.budgetFit.projectedCostPerWear !== null
    ? `<div class="finding note">Projected ${usd(s.budgetFit.projectedCostPerWear)}/wear (median wears of your ${esc(quest.category)} pieces, sample of ${s.budgetFit.wearSample})<span class="src">your vault (VAULT tab)</span></div>`
    : `<div class="finding note">No cost-per-wear projection: no worn ${esc(quest.category)} in the vault yet.</div>`;
  const delta = s.budgetFit.deltaUsd === null
    ? `<div class="finding violation">Price unknown: budget fit scored 0 and this candidate cannot be recommended until priced.</div>`
    : s.budgetFit.deltaUsd <= 0
      ? `<div class="finding good">${usd(-s.budgetFit.deltaUsd)} under the ${usd(quest.targetUsd)} target.</div>`
      : `<div class="finding note">${usd(s.budgetFit.deltaUsd)} over target: needs love ceiling coverage (yours now: ${usd(loveCeilingUsd(quest, qc.love))}).</div>`;
  return `
    <details class="manual" style="margin-top:6px">
      <summary>SCORE BREAKDOWN · NEED ${s.needFit.score} · AESTHETIC ${s.aestheticFit.declared ? `${s.aestheticFit.score} · YOUR EYE` : s.aestheticFit.evidence === false ? "—" : s.aestheticFit.score} · BUDGET ${s.budgetFit.score}</summary>
      ${aesNote}
      <div class="muted" style="margin:8px 0 6px">Composite = need ×0.4 + aesthetic ×0.3 + budget ×0.3. Formulas are code (src/quests.ts); love is yours alone.</div>
      ${s.needFit.mustMatched.length ? `<div class="finding good">Must-haves matched: ${s.needFit.mustMatched.map((m: string) => esc(s.needFit.matchedVia?.[m] && s.needFit.matchedVia[m] !== "listing text" ? `${m} ← ${s.needFit.matchedVia[m]}` : m)).join(" · ")}</div>` : ""}
      ${s.needFit.mustMissed.length ? `<div class="finding violation">Must-haves missing: ${esc(s.needFit.mustMissed.join(", "))}</div>` : ""}
      ${s.needFit.mustNotHit?.length ? `<div class="finding violation">Has what you excluded: ${esc(s.needFit.mustNotHit.join(", "))}. Need docked 15 each; exclusions are preferences, not gates, so it stays choosable.</div>` : ""}
      ${list("Nice-to-haves matched", s.needFit.niceMatched)}
      ${list("Nice-to-haves missing", s.needFit.niceMissed)}
      ${list("Doctrine signals", s.aestheticFit.signalsMatched)}
      ${list("Preferred materials", s.aestheticFit.preferredHits)}
      ${delta}
      ${cpw}
      ${qc.gateViolations.map((v: string) => `<div class="finding violation">${esc(v)}</div>`).join("")}
    </details>`;
}

async function renderVerdictSurface(): Promise<void> {
  view.innerHTML = `<div class="empty">LOADING…</div>`;
  let quests: any, receipts: any;
  try {
    [quests, receipts] = await Promise.all([api("/api/quests"), api("/api/decisions")]);
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(String((e as Error).message))}</div>`;
    return;
  }

  const quest = openQuestId ? quests.open.find((q: any) => q.id === openQuestId) : null;
  if (openQuestId && !quest) openQuestId = null;
  if (batchReport && batchReport.questId !== openQuestId) batchReport = null;

  view.innerHTML = "";
  if (quest) {
    // A quest detail takes the whole surface; ← ALL QUESTS returns home.
    view.appendChild(questDetailEl(quest));
    view.appendChild(receiptsEl(receipts));
    return;
  }

  // Home: the temptation box first, then open quests, then the paper trail.
  view.appendChild(verdictInputEl());
  view.appendChild(questListEl(quests));
  view.appendChild(historyEl());
  view.appendChild(receiptsEl(receipts));
  const rules = rulesOnFileHtml();
  if (rules) view.appendChild(el(rules));
  loadHistory();
}

function questListEl(quests: any): HTMLElement {
  const rows = quests.open.length
    ? quests.open.map((q: any) => `
      <div class="item-row" data-open-quest="${esc(q.id)}" role="button" tabindex="0" style="cursor:pointer">
        <div>
          <div class="title">${esc(q.title)}</div>
          <div class="meta">${esc(q.category)} · target ${usd(q.targetUsd)} / stretch ${usd(q.stretchUsd)}${q.deadline ? ` · by ${esc(q.deadline)}` : ""} · ${q.candidates.length} candidate${q.candidates.length === 1 ? "" : "s"}</div>
        </div>
        <span class="mono" style="font-size:10px;letter-spacing:.14em">${q.ranking.recommendedId ? "► HAS PICK" : "OPEN"}</span>
      </div>`).join("")
    : `<div class="empty" style="letter-spacing:.12em;line-height:2">NO OPEN QUESTS.<br>A QUEST IS ONE NEED YOU'RE SHOPPING: NAME IT, SET A TARGET AND A STRETCH PRICE, THEN COLLECT CANDIDATES OVER DAYS OR WEEKS. THE MONOLITH RANKS THEM AND REMEMBERS WHY YOU CHOSE.</div>`;

  const wrap = el(`
    <div>
      <h2 class="section">WHICH ONE DO I BUY? · OPEN QUESTS</h2>
      <div class="panel">${rows}</div>
      <h2 class="section" id="q-start">START A QUEST</h2>
      <div class="panel">
        <div id="q-queued">${queuedNoteHtml()}</div>
        <div class="muted" style="margin-bottom:12px">One need per quest. The budget is a band: the target is what you plan to spend; the stretch is the most you'd ever spend if you love the piece. Declared love (1-5) unlocks the band between them, and nothing else.</div>
        <label>What are you looking for?</label><input id="q-title" placeholder="e.g. black boots that survive a wet winter" />
        <div class="row2">
          <div><label>Category</label>
            <select id="q-cat">
              <option>outerwear</option><option>tops</option><option>bottoms</option>
              <option>footwear</option><option>accessories</option>
            </select>
          </div>
          <div><label>Decide by (YYYY-MM-DD, optional)</label><input id="q-deadline" placeholder="" /></div>
        </div>
        <div class="row2">
          <div><label>Target price USD</label><input id="q-target" type="number" inputmode="decimal" /></div>
          <div><label>Stretch ceiling USD</label><input id="q-stretch" type="number" inputmode="decimal" /></div>
        </div>
        <label>Must-haves (comma-separated, short terms)</label><input id="q-must" placeholder="e.g. leather, laptop compartment, black" />
        <div id="q-chips"></div>
        <div class="muted" style="margin:-6px 0 10px">One idea per term. Matching understands synonyms and each listing's structured read ("laptop compartment" credits a page that says "padded 16&quot; sleeve"), but a full sentence still won't match: keep terms short.</div>
        <label>Nice-to-haves (comma-separated)</label><input id="q-nice" placeholder="e.g. side zip, goodyear welt" />
        <label>Must-NOT-haves (dealbreakers, comma-separated)</label><input id="q-mustnot" placeholder="e.g. visible logo, suede" />
        <div id="q-mustnot-chips">${chipRowHtml("q-mustnot", MUST_NOT_CHIPS)}</div>
        <button class="cta" id="q-create">OPEN THE QUEST</button>
      </div>
    </div>`);

  wrap.querySelectorAll<HTMLElement>("[data-open-quest]").forEach((row) => {
    const open = () => { openQuestId = row.dataset.openQuest!; renderVerdictSurface(); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") open(); });
  });

  // Must-have chips follow the selected category; must-not chips are static.
  const catSelect = wrap.querySelector("#q-cat") as HTMLSelectElement;
  const chipBox = wrap.querySelector("#q-chips") as HTMLElement;
  const renderChips = () => {
    chipBox.innerHTML = chipRowHtml("q-must", REQUIREMENT_CHIPS[catSelect.value] ?? []);
    wireChips(chipBox, wrap);
  };
  catSelect.addEventListener("change", renderChips);
  renderChips();
  wireChips(wrap.querySelector("#q-mustnot-chips") as HTMLElement, wrap);

  wrap.querySelector("#q-create")!.addEventListener("click", async () => {
    const btn = wrap.querySelector("#q-create") as HTMLButtonElement;
    try {
      const target = Number.parseFloat((wrap.querySelector("#q-target") as HTMLInputElement).value);
      const stretchRaw = Number.parseFloat((wrap.querySelector("#q-stretch") as HTMLInputElement).value);
      btn.disabled = true;
      const r = await api("/api/quests", {
        method: "POST",
        body: JSON.stringify({
          title: (wrap.querySelector("#q-title") as HTMLInputElement).value.trim(),
          category: (wrap.querySelector("#q-cat") as HTMLSelectElement).value,
          targetUsd: target,
          stretchUsd: Number.isFinite(stretchRaw) ? stretchRaw : target,
          mustHaves: splitCsv((wrap.querySelector("#q-must") as HTMLInputElement).value),
          niceToHaves: splitCsv((wrap.querySelector("#q-nice") as HTMLInputElement).value),
          mustNotHaves: splitCsv((wrap.querySelector("#q-mustnot") as HTMLInputElement).value),
          deadline: (wrap.querySelector("#q-deadline") as HTMLInputElement).value.trim() || undefined,
        }),
      });
      // Links staged on the verdict box become the quest's first contenders.
      if (pendingUrls?.length) {
        const urls = pendingUrls;
        pendingUrls = null;
        const { added, failures } = await batchAddUrls(r.quest.id, r.quest.category, urls,
          (label) => { btn.textContent = label; });
        batchReport = { questId: r.quest.id, added, failures };
        toast(`QUEST OPEN: ${added} OF ${urls.length} CONTENDER${urls.length === 1 ? "" : "S"} ADDED.`);
      }
      openQuestId = r.quest.id;
      renderVerdictSurface();
    } catch (e) {
      toast(String((e as Error).message));
      btn.disabled = false;
      btn.textContent = "OPEN THE QUEST";
    }
  });

  return wrap;
}

function questDetailEl(quest: any): HTMLElement {
  const ranked: any[] = quest.ranking.order
    .map((id: string) => quest.candidates.find((c: any) => c.id === id))
    .filter(Boolean);

  const rows = ranked.length
    ? ranked.map((qc: any, i: number) => {
        const rec = qc.id === quest.ranking.recommendedId;
        const gateTag = qc.gatePassed
          ? ""
          : ` <span class="mono" style="font-size:10px;text-decoration:underline">✕ GATE-REJECTED</span>`;
        return `
        <div class="item-row" style="display:block${rec ? ";border-left:3px solid var(--ink);padding-left:10px" : ""}">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
            <div>
              <div class="title">${rec ? "► " : ""}#${i + 1} · ${esc(qc.candidate.brand)}, ${esc(qc.candidate.name)}${gateTag}</div>
              <div class="meta">${usd(qc.candidate.priceUsd)}${qc.candidate.platform ? ` · ${esc(qc.candidate.platform)}` : ""} · added ${esc(qc.addedAt.slice(0, 10))}</div>
            </div>
            <span class="score-num">${qc.score.total}</span>
          </div>
          ${qc.candidate.digest ? `<div class="meta" style="margin-top:7px;color:var(--ink);line-height:1.5">${esc(qc.candidate.digest)}</div>` : ""}
          ${qc.rationale ? `<div class="finding note" style="margin-top:7px">${esc(qc.rationale)}<span class="src">composed from your quest, profile, and vault: src/quests.ts</span></div>` : ""}
          ${quest.ranking.comparatives?.[qc.id] ? `<div class="finding note" style="margin-top:7px">${esc(quest.ranking.comparatives[qc.id])}<span class="src">rank comparison, recomputed from the same scores: src/quests.ts</span></div>` : ""}
          <div style="margin:8px 0 0;display:flex;gap:4px;align-items:center;flex-wrap:wrap">
            ${loveButtonsHtml(qc)}
            ${eyeApplies(quest, qc) ? `<span style="width:10px"></span>${eyeButtonsHtml(qc)}` : ""}
            <span style="flex:1"></span>
            ${qc.gatePassed ? `<button class="mini" data-choose="${esc(qc.id)}">CHOOSE</button>` : ""}
            <button class="mini danger" data-drop="${esc(qc.id)}">DROP</button>
          </div>
          ${scoreBreakdownHtml(qc, quest)}
        </div>`;
      }).join("")
    : `<div class="empty">NO CANDIDATES YET. ADD THE FIRST CONTENDER BELOW.</div>`;

  const wrap = el(`
    <div>
      <div class="quest-head">
        <button class="mini" id="q-back">← ALL QUESTS</button>
        <h1 class="quest-title">${esc(quest.title)}</h1>
        <div class="quest-brief">
          <div class="qb-band">${esc(quest.category.toUpperCase())} · TARGET ${usd(quest.targetUsd)} · STRETCH ${usd(quest.stretchUsd)}${quest.deadline ? ` · BY ${esc(quest.deadline)}` : ""}</div>
          <div class="muted">Must: ${esc(quest.mustHaves.join(", ") || "none set")}<br>Nice: ${esc(quest.niceToHaves.join(", ") || "none set")}${quest.mustNotHaves?.length ? `<br>Never: ${esc(quest.mustNotHaves.join(", "))}` : ""}</div>
          <div class="muted" style="margin-top:6px">Love unlocks budget: 1 → ${usd(quest.targetUsd)} · 3 → ${usd(loveCeilingUsd(quest, 3))} · 5 → ${usd(quest.stretchUsd)}. Gates are not negotiable at any love.</div>
        </div>
        <details class="manual" style="margin-top:10px">
          <summary>EDIT QUEST · RE-SCORES EVERY CONTENDER</summary>
          <div class="muted" style="margin:10px 0 12px">Short terms, one idea each. Matching understands synonyms and each listing's structured read ("laptop compartment" credits a "padded 16&quot; sleeve" page), but a full sentence with (parentheses) still never matches. Saving re-scores all contenders instantly from their stored data.</div>
          <label>Title</label><input id="qe-title" />
          <div class="row2">
            <div><label>Target price USD</label><input id="qe-target" type="number" inputmode="decimal" /></div>
            <div><label>Stretch ceiling USD</label><input id="qe-stretch" type="number" inputmode="decimal" /></div>
          </div>
          <label>Decide by (YYYY-MM-DD, blank = none)</label><input id="qe-deadline" />
          <label>Must-haves (comma-separated, short terms)</label><input id="qe-must" />
          <div id="qe-chips">${chipRowHtml("qe-must", REQUIREMENT_CHIPS[quest.category] ?? [])}</div>
          <label>Nice-to-haves (comma-separated)</label><input id="qe-nice" />
          <label>Must-NOT-haves (dealbreakers)</label><input id="qe-mustnot" />
          <div id="qe-mustnot-chips">${chipRowHtml("qe-mustnot", MUST_NOT_CHIPS)}</div>
          <button class="ghost" id="qe-save">SAVE + RE-SCORE</button>
          <button class="ghost" id="qe-refresh" style="margin-top:8px">RE-READ ALL LISTINGS · REFRESHES DESCRIPTIONS + PRICES</button>
        </details>
      </div>
      <h2 class="section">CONTENDERS · BEST FIRST</h2>
      <div class="panel">${rows}</div>
      <div class="finding note" style="margin-top:10px">${esc(quest.ranking.rationale)}<span class="src">ranking: src/quests.ts + your profile</span></div>
      <h2 class="section">ADD CANDIDATES</h2>
      <div class="panel">
        <label>Product links · one per line, paste your whole hunting session</label>
        <textarea id="qc-urls" rows="3" placeholder="https://…&#10;https://…"></textarea>
        <button class="cta" id="qc-add-urls">READ LISTINGS + ADD ALL</button>
        <div id="qc-batch-report" class="inline-errors"></div>
        ${extractionAvailable ? "" : `<div class="muted" style="margin-top:8px">Automatic reading is offline (no API key). Use manual entry below.</div>`}
        <details class="manual">
          <summary>MANUAL ENTRY</summary>
          <div class="row2">
            <div><label>Brand</label><input id="qc-brand" /></div>
            <div><label>Price USD</label><input id="qc-price" type="number" inputmode="decimal" /></div>
          </div>
          <label>Product name</label><input id="qc-name" />
          <div class="row2">
            <div><label>Store / platform</label><input id="qc-platform" /></div>
            <div><label>Materials (comma-separated)</label><input id="qc-materials" /></div>
          </div>
          <label>Fit wording (comma-separated)</label><input id="qc-fit" />
          <label>Description</label><textarea id="qc-desc" rows="3"></textarea>
          <button class="ghost" id="qc-add-manual">ADD CANDIDATE</button>
        </details>
      </div>
      <div class="panel" style="margin-top:14px">
        <div class="finding note">Abandoning closes the quest and keeps a record in the decision journal (you looked, you passed). Deleting erases the quest and every contender with no record: use it to start over.</div>
        <button class="ghost" id="q-abandon">ABANDON QUEST · KEEPS A RECORD</button>
        <button class="ghost" id="q-delete" style="margin-top:8px;text-decoration:underline">DELETE QUEST · ERASES IT</button>
      </div>
    </div>`);

  wrap.querySelector("#q-back")!.addEventListener("click", () => { openQuestId = null; renderVerdictSurface(); });

  // Prefill edit fields as DOM properties, never attribute strings (stored-XSS
  // discipline, same as CAPITAL's budget field).
  (wrap.querySelector("#qe-title") as HTMLInputElement).value = quest.title;
  (wrap.querySelector("#qe-target") as HTMLInputElement).value = String(quest.targetUsd);
  (wrap.querySelector("#qe-stretch") as HTMLInputElement).value = String(quest.stretchUsd);
  (wrap.querySelector("#qe-deadline") as HTMLInputElement).value = quest.deadline ?? "";
  (wrap.querySelector("#qe-must") as HTMLInputElement).value = quest.mustHaves.join(", ");
  (wrap.querySelector("#qe-nice") as HTMLInputElement).value = quest.niceToHaves.join(", ");
  (wrap.querySelector("#qe-mustnot") as HTMLInputElement).value = (quest.mustNotHaves ?? []).join(", ");
  wireChips(wrap.querySelector("#qe-chips") as HTMLElement, wrap);
  wireChips(wrap.querySelector("#qe-mustnot-chips") as HTMLElement, wrap);

  wrap.querySelector("#qe-save")!.addEventListener("click", async () => {
    try {
      const target = Number.parseFloat((wrap.querySelector("#qe-target") as HTMLInputElement).value);
      const stretch = Number.parseFloat((wrap.querySelector("#qe-stretch") as HTMLInputElement).value);
      await api(`/api/quests/${quest.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: (wrap.querySelector("#qe-title") as HTMLInputElement).value.trim() || undefined,
          targetUsd: Number.isFinite(target) ? target : undefined,
          stretchUsd: Number.isFinite(stretch) ? stretch : undefined,
          deadline: (wrap.querySelector("#qe-deadline") as HTMLInputElement).value.trim(),
          mustHaves: splitCsv((wrap.querySelector("#qe-must") as HTMLInputElement).value),
          niceToHaves: splitCsv((wrap.querySelector("#qe-nice") as HTMLInputElement).value),
          mustNotHaves: splitCsv((wrap.querySelector("#qe-mustnot") as HTMLInputElement).value),
        }),
      });
      toast("QUEST UPDATED. EVERY CONTENDER RE-SCORED.");
      renderVerdictSurface();
    } catch (e) { toast(String((e as Error).message)); }
  });

  wrap.querySelector("#qe-refresh")!.addEventListener("click", async () => {
    const btn = wrap.querySelector("#qe-refresh") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "RE-READING EVERY LISTING… (THIS TAKES A WHILE)";
    try {
      const r = await api(`/api/quests/${quest.id}/refresh`, { method: "POST" });
      toast(`RE-READ ${r.refreshed} LISTING${r.refreshed === 1 ? "" : "S"}.${r.failures.length ? ` ${r.failures.length} FAILED.` : ""}`);
      if (r.failures.length) console.warn("refresh failures:", r.failures);
      renderVerdictSurface();
    } catch (e) {
      toast(String((e as Error).message));
      btn.disabled = false;
      btn.textContent = "RE-READ ALL LISTINGS · REFRESHES DESCRIPTIONS + PRICES";
    }
  });

  async function addCandidate(candidate: any): Promise<void> {
    const r = await api(`/api/quests/${quest.id}/candidates`, {
      method: "POST",
      body: JSON.stringify({ ...candidate, category: quest.category }),
    });
    if (!r.quest.candidates.find((c: any) => c.verdictId === r.verdict.id)?.gatePassed) {
      toast("ADDED, BUT THE GATES REJECT IT. IT STAYS VISIBLE AND UNCHOOSABLE.");
    }
    renderVerdictSurface();
  }

  // Surface the last batch outcome and keep failed links in the box for retry.
  const report = batchReport && batchReport.questId === quest.id ? batchReport : null;
  if (report) {
    (wrap.querySelector("#qc-urls") as HTMLTextAreaElement).value =
      report.failures.map((f) => f.url).join("\n");
    (wrap.querySelector("#qc-batch-report") as HTMLElement).innerHTML =
      `<div class="finding ${report.failures.length ? "note" : "good"}">LAST BATCH: ${report.added} ADDED · ${report.failures.length} FAILED${report.failures.length ? ". FAILED LINKS KEPT ABOVE: FIX, RETRY, OR USE MANUAL ENTRY." : ""}</div>` +
      report.failures.map((f) => `<div class="finding violation">${esc(f.url)}: ${esc(f.error)}</div>`).join("");
  }

  wrap.querySelector("#qc-add-urls")!.addEventListener("click", async () => {
    const box = wrap.querySelector("#qc-urls") as HTMLTextAreaElement;
    const urls = parseUrlLines(box.value);
    const btn = wrap.querySelector("#qc-add-urls") as HTMLButtonElement;
    if (!urls.length) { toast("PASTE AT LEAST ONE LINK, OR USE MANUAL ENTRY."); return; }
    btn.disabled = true;
    const { added, failures } = await batchAddUrls(quest.id, quest.category, urls,
      (label) => { btn.textContent = label; });
    batchReport = { questId: quest.id, added, failures };
    toast(`BATCH DONE: ${added} OF ${urls.length} ADDED.`);
    renderVerdictSurface();
  });

  wrap.querySelector("#qc-add-manual")!.addEventListener("click", async () => {
    const num = Number.parseFloat((wrap.querySelector("#qc-price") as HTMLInputElement).value);
    try {
      await addCandidate({
        brand: (wrap.querySelector("#qc-brand") as HTMLInputElement).value,
        name: (wrap.querySelector("#qc-name") as HTMLInputElement).value,
        priceUsd: Number.isFinite(num) ? num : null,
        platform: (wrap.querySelector("#qc-platform") as HTMLInputElement).value || undefined,
        materials: splitCsv((wrap.querySelector("#qc-materials") as HTMLInputElement).value),
        fitDescriptors: splitCsv((wrap.querySelector("#qc-fit") as HTMLInputElement).value),
        descriptionText: (wrap.querySelector("#qc-desc") as HTMLTextAreaElement).value,
      });
    } catch (e) { toast(String((e as Error).message)); }
  });

  wrap.querySelectorAll<HTMLElement>("[data-love]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api(`/api/quests/${quest.id}/candidates/${b.dataset.loveCand}/love`, {
          method: "POST",
          body: JSON.stringify({ love: Number(b.dataset.love) }),
        });
        renderVerdictSurface();
      } catch (e) { toast(String((e as Error).message)); }
    }));

  wrap.querySelectorAll<HTMLElement>("[data-eye]").forEach((b) =>
    b.addEventListener("click", async () => {
      const qc = quest.candidates.find((x: any) => x.id === b.dataset.eyeCand);
      // tapping the active verdict clears it back to text evidence
      const next = qc?.eye === b.dataset.eye ? null : b.dataset.eye;
      try {
        await api(`/api/quests/${quest.id}/candidates/${b.dataset.eyeCand}/eye`, {
          method: "POST",
          body: JSON.stringify({ eye: next }),
        });
        renderVerdictSurface();
      } catch (e) { toast(String((e as Error).message)); }
    }));

  wrap.querySelectorAll<HTMLElement>("[data-drop]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Drop this candidate from the quest?")) return;
      try {
        await api(`/api/quests/${quest.id}/candidates/${b.dataset.drop}`, { method: "DELETE" });
        renderVerdictSurface();
      } catch (e) { toast(String((e as Error).message)); }
    }));

  wrap.querySelectorAll<HTMLElement>("[data-choose]").forEach((b) =>
    b.addEventListener("click", async () => {
      const qc = quest.candidates.find((x: any) => x.id === b.dataset.choose);
      const motivation = prompt(
        `Choosing ${qc?.candidate?.brand}, ${qc?.candidate?.name}.\n\nWhy this one? One line, in your words, for the record:`,
      );
      if (!motivation || !motivation.trim()) return;
      const recordPurchase = confirm(
        "OK = bought it: record to ledger (CAPITAL) and wardrobe (VAULT) now.\nCancel = decision only; record the purchase later from GATE.",
      );
      try {
        await api(`/api/quests/${quest.id}/decide`, {
          method: "POST",
          body: JSON.stringify({ candidateId: b.dataset.choose, motivation, recordPurchase }),
        });
        toast(recordPurchase ? "DECIDED + RECORDED ✓" : "DECIDED ✓ (NOT YET PURCHASED)");
        openQuestId = null;
        refreshBudgetStrip();
        renderVerdictSurface();
      } catch (e) { toast(String((e as Error).message)); }
    }));

  wrap.querySelector("#q-delete")!.addEventListener("click", async () => {
    const n = quest.candidates.length;
    if (!confirm(`Delete "${quest.title}" and its ${n} contender${n === 1 ? "" : "s"}?\n\nThis erases it completely: no record is kept.`)) return;
    try {
      await api(`/api/quests/${quest.id}`, { method: "DELETE" });
      toast("QUEST DELETED.");
      openQuestId = null;
      renderVerdictSurface();
    } catch (e) { toast(String((e as Error).message)); }
  });

  wrap.querySelector("#q-abandon")!.addEventListener("click", async () => {
    const motivation = prompt("Abandoning the quest. Why? (kept in the decision journal)");
    if (motivation === null) return;
    try {
      await api(`/api/quests/${quest.id}/abandon`, {
        method: "POST",
        body: JSON.stringify({ motivation }),
      });
      openQuestId = null;
      renderVerdictSurface();
    } catch (e) { toast(String((e as Error).message)); }
  });

  return wrap;
}

function receiptsEl(receipts: any): HTMLElement {
  const tiers = receipts.byLove.length
    ? receipts.byLove.map((t: any) => `
      <div class="item-row">
        <div class="title">${t.love === 0 ? "LOVE UNDECLARED" : `LOVE ${t.love}/5`}</div>
        <div class="mono" style="font-size:11px">${t.purchases} bought · ${t.avgCostPerWear === null ? "no wear data yet" : `avg ${usd(t.avgCostPerWear)}/wear`}${t.unworn ? ` · ${t.unworn} unworn` : ""}</div>
      </div>`).join("")
    : "";
  const rows = receipts.outcomes.length
    ? receipts.outcomes.slice(0, 15).map((o: any) => {
        const r = o.record;
        const head = r.outcome === "abandoned"
          ? `ABANDONED: ${esc(r.questTitle)}`
          : `${esc(r.chosen.brand)}, ${esc(r.chosen.name)} · ${usd(r.chosen.priceUsd)}${r.chosen.love ? ` · love ${r.chosen.love}/5` : ""}`;
        const wear = o.wearCount !== null
          ? ` · now ${o.wearCount === 0 ? "unworn" : `${o.wearCount} wears${o.costPerWear !== null ? ` (${usd(o.costPerWear)}/wear)` : ""}`}`
          : "";
        return `
        <div class="item-row">
          <div>
            <div class="title">${head}</div>
            <div class="meta">${esc(r.at.slice(0, 10))} · ${esc(r.questTitle)} · ${r.rejected.length} passed over${r.stretchUsed ? " · STRETCH USED" : ""}${wear}<br>"${esc(r.motivation)}"</div>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty">NO DECISIONS RECORDED YET. CLOSED QUESTS LAND HERE WITH THEIR MOTIVATION AND, LATER, THEIR WEAR RECORD.</div>`;
  return el(`
    <div>
      <h2 class="section">THE RECEIPTS · WHAT LOVE ACTUALLY COST</h2>
      ${tiers ? `<div class="panel" style="margin-bottom:14px">${tiers}</div>` : ""}
      <div class="panel">${rows}</div>
    </div>`);
}

// ---------- SIZE tab ----------

// Plain-language hints for tailoring jargon (#14) and values that are sizes,
// not lengths, where a cm conversion would assert nonsense.
const MEASUREMENT_HINTS: Record<string, string> = {
  "armscye": "armhole circumference",
  "shoulder": "one shoulder seam, neck to sleevehead (not across the back)",
  "crotch depth": "waist to seat, measured seated",
  "nape to waist": "back neck bone down to waist",
  "body rise": "waist to saddle, seated",
};
const SIZE_NOT_LENGTH = new Set(["head size"]);

function measurementSpecHtml(): string {
  const b = profile?.biometrics;
  const m = b?.measurements;
  if (!m) return "";
  const rows = Object.entries(m.values as Record<string, number>)
    .map(([k, raw]) => {
      const v = Number(raw); // numeric coercion: never render a raw profile value
      if (!Number.isFinite(v)) return "";
      const confirm = m.toConfirm?.includes(k) ? " *" : "";
      const hint = MEASUREMENT_HINTS[k]
        ? `<div class="meta" style="font-size:9px">${esc(MEASUREMENT_HINTS[k])}</div>`
        : "";
      const value = SIZE_NOT_LENGTH.has(k)
        ? `${v} (size, not a length)`
        : `${v}&Prime; · ${(v * 2.54).toFixed(1)} cm`;
      return `<div class="item-row" style="padding:7px 0"><div><div class="meta" style="color:var(--ink)">${esc(k.toUpperCase())}${confirm}</div>${hint}</div><div class="mono" style="font-size:12px;flex-shrink:0">${value}</div></div>`;
    })
    .join("");
  const legend = m.toConfirm?.length
    ? `<div class="muted" style="margin-bottom:10px">* transcribed from handwritten notes (confirm at your next fitting)</div>`
    : "";
  return `
    <h2 class="section">YOUR MEASUREMENTS · TAKEN ${esc(m.measuredAt)}</h2>
    <div class="panel">
      ${legend}
      ${rows}
      <div class="muted" style="margin-top:8px">Source: ${esc(m.source)} · weight ${Number(b.weightLb)} lb · shoe US ${Number(b.shoe.us)} ${esc(b.shoe.width)} (${b.shoe.width === "E" ? "wide" : "width"})${b.tagPantWaistIn ? ` · pant label size ${Number(b.tagPantWaistIn)}` : ""}<br>Read-only here: measurements live in your profile file on the server (data/profiles.json).</div>
    </div>`;
}

function renderSize(): void {
  view.innerHTML = "";
  const b = profile?.biometrics;
  const baseline = b
    ? `${Number(b.chestIn)}&Prime; chest · ${Number(b.waistIn)}&Prime; measured waist${b.tagPantWaistIn ? ` (wears label size ${Number(b.tagPantWaistIn)})` : ""} · US ${Number(b.shoe.us)} ${esc(b.shoe.width)} · ${b.thermal === "runs-hot" ? "runs hot (temperature: favor breathable fabrics)" : esc(b.thermal)}`
    : "profile not loaded";
  view.appendChild(el(`
    <div>
      <h2 class="section">WHAT SIZE DO I ORDER?</h2>
      <div class="panel">
        <div class="muted" style="margin-bottom:14px">Brands cut differently. Enter a brand and piece; you get the size to order for your body, with the fit rule it came from.</div>
        <label>Brand</label><input id="s-brand" placeholder="e.g. Rick Owens" />
        <div class="row2">
          <div><label>Category</label>
            <select id="s-cat">
              <option>outerwear</option><option>tops</option><option>bottoms</option>
              <option>footwear</option><option>accessories</option>
            </select>
          </div>
          <div><label>Model / descriptor</label><input id="s-q" placeholder="e.g. creatch cargo" /></div>
        </div>
        <button class="cta" id="s-run">GET SIZING</button>
        <div id="s-brands" class="muted" style="margin-top:12px"></div>
      </div>
      <div id="s-result"></div>
      <div class="muted">On file: ${baseline}. Brands without a stored rule fall back to this baseline.</div>
      ${measurementSpecHtml()}
    </div>`));

  // Show which brands actually have rules (#13): tappable chips prefill the form.
  api("/api/sizing/brands").then((r) => {
    const box = document.getElementById("s-brands");
    if (!box || !r.brands?.length) return;
    box.innerHTML = `<label style="margin-bottom:8px">Brand rules on file</label>` +
      r.brands.map((b: any, i: number) =>
        `<button class="mini" type="button" data-brand-chip="${i}" style="margin:0 6px 6px 0">${esc(b.brand.toUpperCase())} · ${esc(b.categories.join("/"))}</button>`).join("");
    box.querySelectorAll<HTMLElement>("[data-brand-chip]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const b = r.brands[Number(chip.dataset.brandChip)];
        if (!b) return;
        (document.getElementById("s-brand") as HTMLInputElement).value = b.brand;
        const sel = document.getElementById("s-cat") as HTMLSelectElement;
        if (b.categories.length) sel.value = b.categories[0];
        (document.getElementById("s-brand") as HTMLInputElement).focus();
      });
    });
  }).catch(() => { /* chips are progressive enhancement */ });

  document.getElementById("s-run")!.addEventListener("click", async () => {
    const brand = (document.getElementById("s-brand") as HTMLInputElement).value.trim();
    const cat = (document.getElementById("s-cat") as HTMLSelectElement).value;
    const q = (document.getElementById("s-q") as HTMLInputElement).value.trim();
    if (!brand) { toast("BRAND REQUIRED."); return; }
    try {
      const r = await api(`/api/sizing?brand=${encodeURIComponent(brand)}&category=${cat}&q=${encodeURIComponent(q)}`);
      const s = r.sizing;
      document.getElementById("s-result")!.innerHTML = `
        <div class="verdict ${s.fallback ? "insufficient" : "approve"}" style="margin-top:14px">
          <div class="head" style="font-size:15px">${s.fallback ? "NO RULE FOR THIS BRAND (BASELINE)" : "ORDER THIS SIZE"}</div>
          <div class="block">
            <div class="finding note"><strong style="color:var(--ink)">${esc(s.recommendation)}</strong><br>${esc(s.rationale)}<span class="src">${esc(s.source)}</span></div>
          </div>
        </div>`;
    } catch (e) { toast(String((e as Error).message)); }
  });
}

// ---------- VAULT tab ----------
// CARE lives here now, demoted from a surface of its own to what it always
// was: asset protection. Due maintenance and rain risk show as badges on the
// pieces they belong to, plus one compact strip up top. /api/care unchanged.

function months(days: number): string {
  return `every ~${Math.max(1, Math.round(days / 30))} month${Math.round(days / 30) > 1 ? "s" : ""}`;
}

/** The compact care strip: rain alerts + due tasks, collapsed by default. */
function careStripHtml(care: any): string {
  if (!care) return ""; // care is enhancement; the vault never blocks on weather
  const tasks: any[] = care.tasks ?? [];
  const alerts: any[] = care.alerts ?? [];
  const atRisk = alerts.reduce((n: number, a: any) => n + a.itemsAtRisk.length, 0);
  if (!tasks.length && !alerts.length) {
    return `<div class="muted" style="margin-bottom:14px">CARE: all maintenance up to date, no rain threats this week. Tasks build from each piece's materials and appear here when due.</div>`;
  }
  const parts = [
    tasks.length ? `${tasks.length} TASK${tasks.length === 1 ? "" : "S"} DUE` : "",
    atRisk ? `${atRisk} PIECE${atRisk === 1 ? "" : "S"} AT RAIN RISK` : "",
  ].filter(Boolean).join(" · ");
  const clockNote = (t: any) =>
    t.anchorSource === "acquired"
      ? ` · clock started from the acquisition date you entered (${esc(t.anchorDate)})`
      : t.anchorSource === "care-log"
        ? ` · last done ${esc(t.anchorDate)}`
        : "";
  const alertBlocks = alerts.map((a: any) => `
    <div class="alert ${a.severity}" style="margin-top:12px">
      ${esc(a.message)}
      ${a.itemsAtRisk.map((i: any) => `<div class="finding note" style="margin-top:6px">${esc(i.itemLabel)}: ${esc(i.directive)}</div>`).join("")}
    </div>`).join("");
  const taskRows = tasks.map((t: any) => `
    <div class="item-row">
      <div>
        <div class="title">${esc(t.protocolLabel)} (${months(Number(t.intervalDays))}): ${esc(t.itemLabel)}</div>
        <div class="meta">due since ${esc(t.dueSince)} (${Number(t.overdueDays)}d overdue)${clockNote(t)}<br>${esc(t.directive)}</div>
      </div>
      <div class="item-actions"><button class="mini" data-done-item="${t.itemId}" data-done-proto="${t.protocolId}" data-interval="${Number(t.intervalDays)}" data-label="${esc(t.protocolLabel)}">DONE</button></div>
    </div>`).join("");
  return `
    <details class="manual" style="margin:0 0 14px">
      <summary>CARE · ${parts}</summary>
      ${alertBlocks}
      ${taskRows ? `<div style="margin-top:12px">${taskRows}</div>` : ""}
      <div class="muted" style="margin-top:8px">Tasks are assigned from each piece's materials (leather gets conditioning, waxed cotton gets re-waxing). DONE restarts a task's clock from today. Heavy rain ahead flags rain-sensitive pieces.</div>
    </details>`;
}

/**
 * Invisible in: the VAULT panel for order-email ingestion. Perception only
 * on the server; every row here is a PROPOSAL, and the two buttons are the
 * only doorway — confirm writes the piece (and optionally the spend) by
 * code, dismiss buries it. Nothing enters the vault on its own.
 */
let hostedMultiuser = false;

async function loadIngestPanel(): Promise<void> {
  const panel = document.getElementById("v-ingest");
  if (!panel) return;
  let status: any;
  try {
    status = await api("/api/ingest/status");
  } catch {
    panel.innerHTML = `<div class="empty">INGESTION STATUS UNAVAILABLE</div>`;
    return;
  }

  if (!status.available) {
    panel.innerHTML = hostedMultiuser
      ? `<div class="muted">Off. Email ingestion isn't enabled on this server yet. When it is, connecting Gmail (read-only) turns order confirmations from your inbox into proposals here — and nothing enters the vault without your confirm.</div>`
      : `<div class="muted">Off. Add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (and ANTHROPIC_API_KEY) to .env — see .env.example — and order confirmations from your inbox arrive here as proposals. Nothing enters the vault without your confirm.</div>`;
    return;
  }

  if (!status.connected) {
    panel.innerHTML = `
      <div class="muted" style="margin-bottom:12px">Connect Gmail (read-only) and recent order confirmations become proposed vault entries: no cataloging chore. The reader only extracts what each email states; you confirm or dismiss every piece, and only your confirm writes to VAULT or CAPITAL.</div>
      <button class="cta" id="ing-connect">CONNECT GMAIL · READ-ONLY</button>`;
    panel.querySelector("#ing-connect")!.addEventListener("click", () => {
      window.location.href = "/api/ingest/oauth/start";
    });
    return;
  }

  let proposals: any[] = [];
  try {
    proposals = (await api("/api/ingest/proposals")).proposals;
  } catch { /* rows below just show empty */ }

  const catOptions = (selected: string | null) =>
    [`<option value=""${selected ? "" : " selected"}>— pick category —</option>`]
      .concat(["outerwear", "tops", "bottoms", "footwear", "accessories"].map(
        (c) => `<option value="${c}"${selected === c ? " selected" : ""}>${c}</option>`,
      )).join("");

  const rows = proposals.length
    ? proposals.map((p: any) => `
      <div class="item-row" style="display:block">
        <div class="title">${esc(p.item.brand ?? p.merchant ?? "Unknown brand")}, ${esc(p.item.name)}</div>
        <div class="meta">${usd(p.item.priceUsd)}${p.item.sizeLabel ? ` · size ${esc(p.item.sizeLabel)}` : ""}${p.merchant ? ` · ${esc(p.merchant)}` : ""}${p.orderDate ? ` · ordered ${esc(p.orderDate)}` : ""} · read ${esc(p.confidence)}-confidence from "${esc(p.source.subject)}"</div>
        <div style="margin:8px 0 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select data-ing-cat="${esc(p.id)}" style="width:auto;margin:0">${catOptions(p.item.category)}</select>
          ${p.item.priceUsd !== null ? `<label style="display:flex;align-items:center;gap:5px;margin:0;text-transform:none;letter-spacing:.05em"><input type="checkbox" data-ing-spend="${esc(p.id)}" checked style="width:auto;margin:0" />record ${usd(p.item.priceUsd)} to CAPITAL</label>` : ""}
          <span style="flex:1"></span>
          <button class="mini" data-ing-confirm="${esc(p.id)}">ADD TO VAULT</button>
          <button class="mini danger" data-ing-dismiss="${esc(p.id)}">DISMISS</button>
        </div>
      </div>`).join("")
    : `<div class="muted" style="margin-top:10px">No open proposals. SYNC reads recent order emails; apparel purchases land here for your confirm.</div>`;

  panel.innerHTML = `
    <div class="muted" style="margin-bottom:10px">CONNECTED: ${esc(status.email ?? "Gmail")} · read-only. Extraction proposes; only you commit.</div>
    <button class="cta" id="ing-sync">SYNC ORDERS · LAST 60 DAYS</button>
    ${rows}
    <button class="ghost" id="ing-disconnect" style="margin-top:12px">DISCONNECT GMAIL</button>`;

  panel.querySelector("#ing-sync")!.addEventListener("click", async () => {
    const btn = panel.querySelector("#ing-sync") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "READING ORDER EMAILS… (THIS TAKES A WHILE)";
    try {
      const r = await api("/api/ingest/sync", { method: "POST", body: JSON.stringify({}) });
      const rep = r.report;
      toast(`SYNC DONE: ${rep.proposed} PROPOSED · ${rep.notApparel} NOT APPAREL · ${rep.skippedPrefilter} SKIPPED${rep.duplicates ? ` · ${rep.duplicates} DUPLICATE${rep.duplicates === 1 ? "" : "S"} COLLAPSED` : ""}${rep.failures.length ? ` · ${rep.failures.length} FAILED` : ""}${rep.moreRemaining ? " · MORE MAIL REMAINS: SYNC AGAIN TO GO DEEPER" : ""}`);
      if (rep.failures.length) console.warn("ingest failures:", rep.failures);
      loadIngestPanel();
    } catch (e) {
      toast(String((e as Error).message));
      btn.disabled = false;
      btn.textContent = "SYNC ORDERS · LAST 60 DAYS";
    }
  });

  panel.querySelector("#ing-disconnect")!.addEventListener("click", async () => {
    if (!confirm("Disconnect Gmail? Open proposals stay; syncing stops until you reconnect.")) return;
    try {
      await api("/api/ingest/disconnect", { method: "POST", body: JSON.stringify({}) });
      loadIngestPanel();
    } catch (e) { toast(String((e as Error).message)); }
  });

  panel.querySelectorAll<HTMLElement>("[data-ing-confirm]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.ingConfirm!;
      const cat = (panel.querySelector(`[data-ing-cat="${id}"]`) as HTMLSelectElement).value;
      if (!cat) { toast("PICK A CATEGORY FIRST."); return; }
      const spendBox = panel.querySelector(`[data-ing-spend="${id}"]`) as HTMLInputElement | null;
      (b as HTMLButtonElement).disabled = true;
      try {
        await api(`/api/ingest/proposals/${id}/confirm`, {
          method: "POST",
          body: JSON.stringify({ category: cat, recordSpend: spendBox?.checked === true }),
        });
        toast("COMMITTED TO VAULT ✓");
        refreshBudgetStrip();
        renderVault();
      } catch (e) {
        toast(String((e as Error).message));
        (b as HTMLButtonElement).disabled = false;
      }
    }));

  panel.querySelectorAll<HTMLElement>("[data-ing-dismiss]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api(`/api/ingest/proposals/${b.dataset.ingDismiss}/dismiss`, {
          method: "POST", body: JSON.stringify({}),
        });
        loadIngestPanel();
      } catch (e) { toast(String((e as Error).message)); }
    }));
}

async function renderVault(): Promise<void> {
  view.innerHTML = "";
  const wrap = el(`
    <div>
      <h2 class="section">WARDROBE VAULT: WHAT YOU OWN</h2>
      <div id="v-care"></div>
      <button class="ghost" id="v-wear-today" style="margin:0 0 14px">LOG TODAY'S WEAR · ONE TAP</button>
      <div class="panel" id="v-list"><div class="empty">LOADING…</div></div>
      <h2 class="section">INVISIBLE IN · ORDER EMAILS</h2>
      <div class="panel" id="v-ingest"><div class="empty">CHECKING…</div></div>
      <h2 class="section">ADD A PIECE</h2>
      <div class="panel">
        <div class="row2">
          <div><label>Brand</label><input id="v-brand" /></div>
          <div><label>Category</label>
            <select id="v-cat">
              <option>outerwear</option><option>tops</option><option>bottoms</option>
              <option>footwear</option><option>accessories</option>
            </select>
          </div>
        </div>
        <label>Name</label><input id="v-name" />
        <div class="row2">
          <div><label>Price USD</label><input id="v-price" type="number" inputmode="decimal" /></div>
          <div><label>Acquired (YYYY-MM-DD)</label><input id="v-date" placeholder="2026-07-06" /></div>
        </div>
        <label>Materials (comma-separated)</label><input id="v-materials" />
        <button class="cta" id="v-add">COMMIT TO VAULT</button>
      </div>
      <h2 class="section">BULK IMPORT</h2>
      <div class="panel">
        <div class="muted" style="margin-bottom:8px">One line per piece, in this order:<br><span class="mono">category | brand | name | materials,comma | price | acquired</span><br>Valid lines are written immediately; failing lines are listed below. Fix and re-import just those.</div>
        <textarea id="v-import" rows="5" placeholder="e.g. bottoms | Rick Owens | Creatch Cargo | cotton twill | 890 | 2025-11-29"></textarea>
        <div id="v-import-errors" class="inline-errors"></div>
        <button class="ghost" id="v-import-run">IMPORT LINES</button>
      </div>
    </div>`);
  view.appendChild(wrap);

  async function load(): Promise<void> {
    const [r, care] = await Promise.all([
      api("/api/inventory"),
      api("/api/care").catch(() => null), // weather can fail; the vault must not
    ]);
    const box = document.getElementById("v-list")!;
    const careBox = document.getElementById("v-care");
    if (careBox) careBox.innerHTML = careStripHtml(care);

    if (!r.items.length) {
      box.innerHTML = `<div class="empty" style="letter-spacing:.12em;line-height:2">VAULT EMPTY. YOUR OWNED WARDROBE LIVES HERE.<br>RECORDED PURCHASES LAND HERE AUTOMATICALLY; THE GATE USES IT TO CATCH DUPLICATES, AND CARE SCHEDULES BUILD FROM EACH PIECE'S MATERIALS.</div>`;
      return;
    }

    // Care state maps onto the pieces it protects: a badge per at-risk row.
    const dueByItem = new Map<string, any[]>();
    for (const t of care?.tasks ?? []) {
      dueByItem.set(t.itemId, [...(dueByItem.get(t.itemId) ?? []), t]);
    }
    const rainRisk = new Set<string>(
      (care?.alerts ?? []).flatMap((a: any) => a.itemsAtRisk.map((i: any) => i.itemId)),
    );
    const badges = (i: any) => {
      const due = dueByItem.get(i.id) ?? [];
      if (!due.length && !rainRisk.has(i.id)) return "";
      return `<div class="care-badges">${rainRisk.has(i.id) ? `<span class="care-badge warn">⚠ RAIN · PROTECT</span>` : ""}${due.map((t: any) => `<span class="care-badge">${esc(String(t.protocolLabel).toUpperCase())} DUE</span>`).join("")}</div>`;
    };

    const order = ["outerwear", "tops", "bottoms", "footwear", "accessories"];
    const sorted = [...r.items].sort((a: any, b: any) => order.indexOf(a.category) - order.indexOf(b.category));
    const byId = new Map(sorted.map((i: any) => [i.id, i]));
    box.innerHTML = sorted.map((i: any) => `
      <div class="item-row">
        <div>
          <div class="title">${esc(i.brand)}, ${esc(i.name)}</div>
          <div class="meta">${esc(i.category)}${i.sizeLabel ? ` · ${esc(i.sizeLabel)}` : ""} · ${esc(i.materials.join(", ") || "materials unrecorded")}<br>
          ${i.wearCount === 0 ? "unworn" : `wears ${i.wearCount}`}${i.costPerWear !== null ? ` · ${usd(i.costPerWear)}/wear` : ""}</div>
          ${badges(i)}
        </div>
        <div class="item-actions">
          <button class="mini" data-wear="${i.id}" title="Log one wear">WEAR+</button>
          <button class="mini danger" data-del="${i.id}">REMOVE</button>
        </div>
      </div>`).join("");

    // DONE inside the care strip: log it, restart its clock, re-render.
    careBox?.querySelectorAll("[data-done-item]").forEach((b) =>
      b.addEventListener("click", async () => {
        const btn = b as HTMLElement;
        try {
          await api("/api/care/log", {
            method: "POST",
            body: JSON.stringify({ itemId: btn.dataset.doneItem, protocolId: btn.dataset.doneProto }),
          });
          const interval = Number(btn.dataset.interval || 0);
          const next = new Date(Date.now() + interval * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          toast(`LOGGED ✓. NEXT ${(btn.dataset.label || "TASK").toUpperCase()} DUE ~${next}`);
          load();
        } catch (e) { toast(String((e as Error).message)); }
      }));

    box.querySelectorAll("[data-wear]").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await api(`/api/inventory/${(b as HTMLElement).dataset.wear}/wear`, { method: "POST" });
        toast(`LOGGED: ${r.item.wearCount} WEAR${r.item.wearCount === 1 ? "" : "S"} ✓`);
        load();
      }));
    box.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = (b as HTMLElement).dataset.del!;
        const item: any = byId.get(id);
        if (!confirm(`Remove ${item?.brand ?? "this piece"}, ${item?.name ?? ""} from the vault?`)) return;
        // A recorded purchase carries a linked spend entry: offer to fix the
        // budget in the same gesture instead of leaving a phantom charge.
        let cascade = false;
        if (item?.linkedLedger?.length) {
          const total = item.linkedLedger.reduce((s: number, e: any) => s + e.amountUsd, 0);
          cascade = confirm(
            `This piece has ${usd(total)} recorded in your CAPITAL ledger.\n\nOK = also delete that spend record (budget goes back up).\nCancel = keep the spend recorded.`,
          );
        }
        const r = await api(`/api/inventory/${id}${cascade ? "?ledger=1" : ""}`, { method: "DELETE" });
        toast(`REMOVED.${r.removedLedger ? ` ${r.removedLedger} LEDGER ENTR${r.removedLedger === 1 ? "Y" : "IES"} DELETED TOO.` : ""}`);
        refreshBudgetStrip();
        load();
      }));
  }

  document.getElementById("v-add")!.addEventListener("click", async () => {
    try {
      const num = Number.parseFloat((document.getElementById("v-price") as HTMLInputElement).value);
      await api("/api/inventory", {
        method: "POST",
        body: JSON.stringify({
          brand: (document.getElementById("v-brand") as HTMLInputElement).value,
          name: (document.getElementById("v-name") as HTMLInputElement).value,
          category: (document.getElementById("v-cat") as HTMLSelectElement).value,
          materials: splitCsv((document.getElementById("v-materials") as HTMLInputElement).value),
          priceUsd: Number.isFinite(num) ? num : undefined,
          acquiredAt: (document.getElementById("v-date") as HTMLInputElement).value || undefined,
        }),
      });
      toast("ASSET COMMITTED.");
      load();
    } catch (e) { toast(String((e as Error).message)); }
  });

  document.getElementById("v-import-run")!.addEventListener("click", async () => {
    const errBox = document.getElementById("v-import-errors")!;
    errBox.innerHTML = "";
    try {
      const r = await api("/api/inventory/import", {
        method: "POST",
        body: JSON.stringify({ text: (document.getElementById("v-import") as HTMLTextAreaElement).value }),
      });
      toast(`IMPORTED ${r.imported}.${r.errors.length ? ` ${r.errors.length} LINE${r.errors.length === 1 ? "" : "S"} SKIPPED. SEE BELOW.` : ""}`);
      if (r.errors.length) {
        errBox.innerHTML = r.errors
          .map((e: string) => `<div class="finding violation">${esc(e)}</div>`)
          .join("");
      } else {
        (document.getElementById("v-import") as HTMLTextAreaElement).value = "";
      }
      load();
    } catch (e) { toast(String((e as Error).message)); }
  });

  document.getElementById("v-wear-today")!.addEventListener("click", () => maybeShowWearPrompt(true));

  load();
  loadIngestPanel();
}

// ---------- CAPITAL tab ----------

async function renderCapital(): Promise<void> {
  view.innerHTML = "";
  const r = await api("/api/budget");
  const s = r.status;
  const pct = Math.min(100, Math.max(0, (s.spentUsd / Math.max(1, s.budgetUsd)) * 100));
  const wrap = el(`
    <div>
      <h2 class="section">BUDGET · ${monthLabel(s.month)} ${s.month.slice(0, 4)}</h2>
      <div class="panel">
        <div class="mono" style="font-size:26px;font-weight:800">${usd(s.remainingUsd)} <span style="font-size:12px;color:var(--dim)">LEFT TO SPEND</span></div>
        <div class="bar"><div class="fill ${s.remainingUsd < 0 ? "over" : ""}" style="width:${pct}%"></div></div>
        <div class="muted mono">${usd(s.spentUsd)} spent of ${usd(s.budgetUsd)} monthly budget · resets on the 1st</div>
        <div class="row2" style="margin-top:12px">
          <div><label>Current monthly budget (USD)</label><input id="c-budget" type="number" /></div>
          <div><label>Over-budget policy</label>
            <select id="c-hardstop">
              <option value="true" ${profile?.budget?.hardStop ? "selected" : ""}>HARD STOP</option>
              <option value="false" ${profile?.budget?.hardStop ? "" : "selected"}>ADVISORY</option>
            </select>
          </div>
        </div>
        <div class="muted" style="margin-bottom:4px">Hard stop: over-budget items fail the budget gate. Advisory: they pass with a warning. These fields show your live settings. Change and save.</div>
        <button class="ghost" id="c-save">SAVE SETTINGS</button>
      </div>
      <h2 class="section">RECORD SPEND BY HAND</h2>
      <div class="panel">
        <div class="muted" style="margin-bottom:12px">For purchases made outside the gate. Gate-approved purchases are recorded from the verdict card instead.</div>
        <label>Description</label><input id="c-desc" placeholder="e.g. brand, item name" />
        <div class="row2">
          <div><label>Amount USD</label><input id="c-amt" type="number" inputmode="decimal" /></div>
          <div><label>Date</label><input id="c-date" value="${new Date().toISOString().slice(0, 10)}" /></div>
        </div>
        <button class="cta" id="c-add">COMMIT TO LEDGER</button>
      </div>
      <h2 class="section">LEDGER</h2>
      <div class="panel" id="c-ledger">
        ${r.entries.length ? r.entries.map((e: any) => `
          <div class="item-row">
            <div>
              <div class="title">${esc(e.description)}</div>
              <div class="meta">${esc(e.date)}${e.platform ? ` · ${esc(e.platform)}` : ""}${e.cleared ? "" : " · PENDING"}</div>
            </div>
            <div class="item-actions">
              <span class="mono" style="font-weight:700">${usd(e.amountUsd)}</span>
              <button class="mini" data-delled="${e.id}">✕</button>
            </div>
          </div>`).join("") : `<div class="empty">NO SPEND RECORDED IN ${monthLabel(s.month)} YET</div>`}
      </div>
    </div>`);
  view.appendChild(wrap);

  // Profile values never enter HTML attribute strings: assigned as a DOM
  // property after parse (stored-XSS hardening, Qodo r2 finding 1).
  const budgetInput = document.getElementById("c-budget") as HTMLInputElement;
  const monthlyNum = Number(profile?.budget?.monthlyUsd);
  budgetInput.value = Number.isFinite(monthlyNum) ? String(monthlyNum) : "";

  document.getElementById("c-save")!.addEventListener("click", async () => {
    try {
      const monthly = Number.parseFloat((document.getElementById("c-budget") as HTMLInputElement).value);
      if (!Number.isFinite(monthly) || monthly <= 0) { toast("BUDGET MUST BE > 0."); return; }
      profile.budget.monthlyUsd = monthly;
      profile.budget.hardStop = (document.getElementById("c-hardstop") as HTMLSelectElement).value === "true";
      await api("/api/profile", { method: "PUT", body: JSON.stringify(profile) });
      toast("ALLOCATION UPDATED.");
      refreshBudgetStrip();
      renderCapital();
    } catch (e) { toast(String((e as Error).message)); }
  });

  document.getElementById("c-add")!.addEventListener("click", async () => {
    try {
      await api("/api/ledger", {
        method: "POST",
        body: JSON.stringify({
          description: (document.getElementById("c-desc") as HTMLInputElement).value,
          amountUsd: Number.parseFloat((document.getElementById("c-amt") as HTMLInputElement).value),
          date: (document.getElementById("c-date") as HTMLInputElement).value,
          cleared: true,
        }),
      });
      toast("LEDGER UPDATED.");
      refreshBudgetStrip();
      renderCapital();
    } catch (e) { toast(String((e as Error).message)); }
  });

  wrap.querySelectorAll("[data-delled]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this ledger entry?")) return;
      await api(`/api/ledger/${(b as HTMLElement).dataset.delled}`, { method: "DELETE" });
      refreshBudgetStrip();
      renderCapital();
    }));
}

// ---------- one-tap wear log ----------
// Recognition, not recall: the bar proposes today's most plausible stack
// (code-ranked from the owner's own history), pre-selected so the whole log
// is one tap. Skippable, and silent once the day is settled.

const EVENING_HOUR = 17;

function removeWearPrompt(): void {
  document.querySelector(".wear-prompt")?.remove();
}

async function maybeShowWearPrompt(force = false): Promise<void> {
  removeWearPrompt();
  let t: any;
  try {
    t = await api("/api/wear/today");
  } catch { return; } // the prompt is enhancement; never block the app
  if (t.logged || (t.skipped && !force)) {
    if (force) toast(t.logged ? "TODAY IS ALREADY LOGGED." : "TODAY WAS SKIPPED. LOGGING ANYWAY:");
    if (t.logged) return;
  }
  if (!force && new Date().getHours() < EVENING_HOUR) return; // evening prompt
  if (!t.prediction.length) return; // empty vault: nothing to recognize

  const selected = new Set<string>(t.prediction.map((p: any) => p.id));
  const bar = el(`
    <div class="wear-prompt">
      <div class="wp-head">
        <span>TONIGHT'S LOG · WHAT DID YOU WEAR?</span>
        <button class="wp-x" title="Not now">×</button>
      </div>
      <div class="wp-chips">${t.prediction.map((p: any) =>
        `<button class="wp-chip on" data-wp="${esc(p.id)}">${esc(p.brand)}, ${esc(p.name)}</button>`).join("")}
      </div>
      <div class="wp-actions">
        <button class="cta" data-wp-log>LOG ${selected.size} PIECE${selected.size === 1 ? "" : "S"} ✓</button>
        <button class="ghost" data-wp-skip>SKIP TODAY</button>
      </div>
    </div>`);

  const syncLabel = () => {
    const btn = bar.querySelector("[data-wp-log]") as HTMLButtonElement;
    btn.disabled = selected.size === 0;
    btn.textContent = selected.size
      ? `LOG ${selected.size} PIECE${selected.size === 1 ? "" : "S"} ✓`
      : "NOTHING SELECTED";
  };

  bar.querySelectorAll<HTMLButtonElement>("[data-wp]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const id = chip.dataset.wp!;
      if (selected.has(id)) { selected.delete(id); chip.classList.remove("on"); }
      else { selected.add(id); chip.classList.add("on"); }
      syncLabel();
    }));

  bar.querySelector(".wp-x")!.addEventListener("click", removeWearPrompt);

  bar.querySelector("[data-wp-log]")!.addEventListener("click", async () => {
    try {
      await api("/api/wear/log", {
        method: "POST",
        body: JSON.stringify({ itemIds: [...selected] }),
      });
      toast(`WORN TODAY: ${selected.size} PIECE${selected.size === 1 ? "" : "S"} LOGGED ✓`);
      removeWearPrompt();
      if (currentTab === "vault") renderVault();
    } catch (e) { toast(String((e as Error).message)); }
  });

  bar.querySelector("[data-wp-skip]")!.addEventListener("click", async () => {
    try {
      await api("/api/wear/skip", { method: "POST", body: JSON.stringify({}) });
      removeWearPrompt();
    } catch (e) { toast(String((e as Error).message)); }
  });

  document.body.appendChild(bar);
}

/** Checks now, then re-checks at the next 17:00 boundary and every one
 *  after: a tab left open across the evening must still get the prompt,
 *  not just whatever hour it happened to boot at. */
function scheduleWearPrompt(): void {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(EVENING_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    window.setTimeout(() => {
      void maybeShowWearPrompt();
      scheduleNext();
    }, next.getTime() - now.getTime());
  };
  void maybeShowWearPrompt();
  scheduleNext();
}

// ---------- router ----------

// ---------- multi-user: sign-in gate + account ----------
// Local single-user installs never see any of this: /api/auth/config says
// multiuser=false and boot proceeds exactly as before Sprint B.

declare global {
  interface Window { Clerk: any }
}

/** Clerk publishable keys encode the frontend-API host: pk_test_<base64("host$")>. */
function clerkFrontendApi(pk: string): string | null {
  const m = pk.match(/^pk_(test|live)_(.+)$/);
  if (!m || !m[2]) return null;
  try {
    const decoded = atob(m[2]);
    const host = decoded.endsWith("$") ? decoded.slice(0, -1) : decoded;
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

function renderAuthPanel(inner: string): HTMLElement {
  document.body.classList.add("gate-mode");
  view.innerHTML = "";
  const panel = el(`<div class="auth-gate">${inner}</div>`);
  view.appendChild(panel);
  return panel;
}

/** Load ClerkJS, and if no session, mount the sign-in UI. True = signed in. */
async function ensureClerkSession(pk: string): Promise<boolean> {
  const host = clerkFrontendApi(pk);
  if (!host) {
    renderAuthPanel(`<div class="gate-copy">SIGN-IN IS MISCONFIGURED<br><span class="dim">CLERK_PUBLISHABLE_KEY did not decode. Check .env on the server.</span></div>`);
    return false;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://${host}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
      s.crossOrigin = "anonymous";
      s.setAttribute("data-clerk-publishable-key", pk);
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("could not reach the sign-in service"));
      document.head.appendChild(s);
    });
    await window.Clerk.load();
  } catch (e) {
    renderAuthPanel(`<div class="gate-copy">SIGN-IN UNAVAILABLE<br><span class="dim">${esc((e as Error).message)}. Reload to retry.</span></div>`);
    return false;
  }
  if (window.Clerk.user) return true;
  const panel = renderAuthPanel(
    `<div class="gate-copy">MONOLITH DECIDES WITH YOU, NOT FOR THE STORE.<br><span class="dim">Sign in to begin.</span></div><div id="clerk-signin"></div>`,
  );
  window.Clerk.mountSignIn(panel.querySelector("#clerk-signin"));
  window.Clerk.addListener(({ user }: any) => {
    if (user) location.reload();
  });
  return false;
}

function mountAccountControls(fake: { user: string } | null): void {
  const topbar = document.getElementById("topbar")!;
  if (topbar.querySelector(".account-btn")) return;
  if (fake) {
    // Dev stand-in: shows who you are, click to switch — lets isolation be
    // exercised as two people without a Clerk account.
    const btn = el(`<button class="account-btn" type="button" title="fake auth (dev only): click to switch user">FAKE · ${esc(fake.user)}</button>`);
    btn.addEventListener("click", () => {
      const next = prompt("Switch fake user to:", fake.user);
      if (next && next.trim()) {
        document.cookie = `monolith-fake-user=${encodeURIComponent(next.trim())}; path=/; max-age=31536000`;
        location.reload();
      }
    });
    topbar.appendChild(btn);
    return;
  }
  const email = window.Clerk?.user?.primaryEmailAddress?.emailAddress ?? "";
  const btn = el(`<button class="account-btn" type="button" title="${esc(email)}">SIGN OUT</button>`);
  btn.addEventListener("click", async () => {
    await window.Clerk.signOut();
    location.reload();
  });
  topbar.appendChild(btn);
}

function readFakeUser(): string {
  const m = document.cookie.match(/(?:^|;\s*)monolith-fake-user=([^;]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : "demo";
}

// ---------- the deep aspirational intake ----------
// One question per screen. The hard answers (body, city, ceiling) feed the
// gates; the aspirational answers (the change, the year-out anchor) feed
// the doctrine and, later, the transformation dial. Server-side code builds
// the profile — this wizard only collects words.

interface IntakeStep {
  title: string;
  sub: string;
  body: () => string;
  /** wire events after render (optional) */
  wire?: (scope: HTMLElement) => void;
  /** pull answers from the DOM; return an error line to block NEXT */
  collect: (scope: HTMLElement) => string | null;
}

async function renderIntake(): Promise<void> {
  document.body.classList.add("gate-mode");
  const ans: any = {
    demographics: "",
    location: null,
    thermal: null,
    sweats: false,
    fabricLoves: [],
    fabricHates: [],
    labelsOwned: [],
    budgetHardStop: true,
  };

  const num = (scope: HTMLElement, id: string): number => {
    const v = Number((scope.querySelector(`#${id}`) as HTMLInputElement)?.value);
    return Number.isFinite(v) ? v : NaN;
  };
  const val = (scope: HTMLElement, id: string): string =>
    ((scope.querySelector(`#${id}`) as HTMLInputElement)?.value ?? "").trim();

  const steps: IntakeStep[] = [
    {
      title: "WHO",
      sub: "MONOLITH answers to you and no one else. Start with a name.",
      body: () => `
        <label class="ilbl" for="it-name">NAME</label>
        <input id="it-name" maxlength="100" value="${esc(ans.name ?? "")}" autocomplete="name" />
        <label class="ilbl" for="it-demo">ABOUT YOU <span class="dim">· optional — age, pronouns, whatever matters</span></label>
        <input id="it-demo" maxlength="300" value="${esc(ans.demographics)}" />`,
      collect: (s) => {
        ans.name = val(s, "it-name");
        ans.demographics = val(s, "it-demo");
        return ans.name ? null : "A name is required.";
      },
    },
    {
      title: "WHERE",
      sub: "Weather is a gate, not a mood. Your city decides what survives.",
      body: () => `
        <label class="ilbl" for="it-city">CITY</label>
        <div class="georow"><input id="it-city" maxlength="100" placeholder="start typing, then search" value="${esc(ans.location?.city ?? "")}" /><button class="ghost" id="it-geo">SEARCH</button></div>
        <div id="it-geo-results">${ans.location ? `<button class="mini geo-pick picked">${esc(ans.location.city)}, ${esc(ans.location.region)}</button>` : ""}</div>
        <label class="ilbl" for="it-zip">POSTAL CODE <span class="dim">· optional</span></label>
        <input id="it-zip" maxlength="20" value="${esc(ans.zip ?? "")}" />`,
      wire: (s) => {
        const results = s.querySelector("#it-geo-results")!;
        const city = s.querySelector("#it-city") as HTMLInputElement;
        // Editing the city text after picking a match orphans the pick:
        // what the field says and what we store must never diverge.
        city.addEventListener("input", () => {
          if (ans.location && city.value.trim() !== ans.location.city) {
            ans.location = null;
            results.innerHTML = "";
          }
        });
        const search = async () => {
          const q = city.value.trim();
          if (q.length < 2) return;
          results.innerHTML = `<span class="dim">searching…</span>`;
          try {
            const r = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
            results.innerHTML = r.matches.length
              ? r.matches
                  .map(
                    (m: any, i: number) =>
                      `<button class="mini geo-pick" data-i="${i}">${esc(m.city)}, ${esc(m.region)} · ${esc(m.country)}</button>`,
                  )
                  .join("")
              : `<span class="dim">nothing found — check the spelling</span>`;
            results.querySelectorAll<HTMLButtonElement>(".geo-pick").forEach((b) =>
              b.addEventListener("click", () => {
                const m = r.matches[Number(b.dataset.i)];
                ans.location = { city: m.city, region: m.region, zip: "", lat: m.lat, lon: m.lon };
                city.value = m.city;
                results.querySelectorAll(".geo-pick").forEach((x) => x.classList.remove("picked"));
                b.classList.add("picked");
              }),
            );
          } catch {
            results.innerHTML = `<span class="dim">search failed — try again</span>`;
          }
        };
        s.querySelector("#it-geo")!.addEventListener("click", search);
        city.addEventListener("keydown", (e) => {
          if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); search(); }
        });
      },
      collect: (s) => {
        ans.zip = val(s, "it-zip");
        if (!ans.location) return "Search for your city and pick a match.";
        ans.location.zip = ans.zip;
        return null;
      },
    },
    {
      title: "BODY",
      sub: "Fit is physics. A tailor's tape beats a guess — but a guess beats a blank.",
      body: () => `
        <div class="igrid">
          <div><label class="ilbl" for="it-height">HEIGHT · IN</label><input id="it-height" type="number" step="0.5" min="30" max="100" value="${ans.heightIn ?? ""}" /></div>
          <div><label class="ilbl" for="it-weight">WEIGHT · LB</label><input id="it-weight" type="number" step="1" min="50" max="1000" value="${ans.weightLb ?? ""}" /></div>
          <div><label class="ilbl" for="it-chest">CHEST · IN</label><input id="it-chest" type="number" step="0.5" min="20" max="80" value="${ans.chestIn ?? ""}" /></div>
          <div><label class="ilbl" for="it-waist">WAIST AT NAVEL · IN</label><input id="it-waist" type="number" step="0.5" min="20" max="80" value="${ans.waistIn ?? ""}" /></div>
          <div><label class="ilbl" for="it-shoe">SHOE · US</label><input id="it-shoe" type="number" step="0.5" min="4" max="20" value="${ans.shoeUs ?? ""}" /></div>
          <div><label class="ilbl" for="it-width">WIDTH</label><input id="it-width" maxlength="4" placeholder="D" value="${esc(ans.shoeWidth ?? "")}" /></div>
        </div>`,
      collect: (s) => {
        ans.heightIn = num(s, "it-height");
        ans.weightLb = num(s, "it-weight");
        ans.chestIn = num(s, "it-chest");
        ans.waistIn = num(s, "it-waist");
        ans.shoeUs = num(s, "it-shoe");
        ans.shoeWidth = val(s, "it-width") || "D";
        for (const k of ["heightIn", "weightLb", "chestIn", "waistIn", "shoeUs"]) {
          if (!Number.isFinite(ans[k]) || ans[k] <= 0) return "Every measurement is required (estimates are fine).";
        }
        return null;
      },
    },
    {
      title: "RUNNING TEMPERATURE",
      sub: "Thermoregulation decides fabrics and layers before taste gets a vote.",
      body: () => `
        <div class="ichoice" id="it-thermal">
          ${(["runs-cold", "neutral", "runs-hot"] as const)
            .map((t) => `<button class="ghost therm ${ans.thermal === t ? "picked" : ""}" data-t="${t}">${t.toUpperCase().replace("-", " ")}</button>`)
            .join("")}
        </div>
        <button class="mini ${ans.sweats ? "picked" : ""}" id="it-sweats">${ans.sweats ? "✓ " : ""}I SWEAT THROUGH LAYERS</button>`,
      wire: (s) => {
        s.querySelectorAll<HTMLButtonElement>(".therm").forEach((b) =>
          b.addEventListener("click", () => {
            ans.thermal = b.dataset.t;
            s.querySelectorAll(".therm").forEach((x) => x.classList.toggle("picked", x === b));
          }),
        );
        const sw = s.querySelector("#it-sweats")!;
        sw.addEventListener("click", () => {
          ans.sweats = !ans.sweats;
          sw.classList.toggle("picked", ans.sweats);
          sw.textContent = `${ans.sweats ? "✓ " : ""}I SWEAT THROUGH LAYERS`;
        });
      },
      collect: () => (ans.thermal ? null : "Pick how you run."),
    },
    {
      title: "FABRIC · LOVES",
      sub: "Textures you reach for. These earn a nod in every future verdict.",
      body: () => `
        <label class="ilbl" for="it-loves">FABRICS YOU LOVE <span class="dim">· comma separated</span></label>
        <input id="it-loves" value="${esc(ans.fabricLoves.join(", "))}" />
        ${chipRowHtml("it-loves", ["wool", "linen", "leather", "raw denim", "cashmere", "waxed cotton", "silk"])}`,
      wire: (s) => wireChips(s),
      collect: (s) => {
        ans.fabricLoves = splitCsv(val(s, "it-loves"));
        return null;
      },
    },
    {
      title: "FABRIC · NEVER",
      sub: "Dealbreakers. MONOLITH will refuse these on your behalf — that is the point.",
      body: () => `
        <label class="ilbl" for="it-hates">FABRICS YOU NEVER WANT <span class="dim">· comma separated</span></label>
        <input id="it-hates" value="${esc(ans.fabricHates.join(", "))}" />
        ${chipRowHtml("it-hates", ["polyester", "acrylic", "nylon", "rayon", "fleece"])}`,
      wire: (s) => wireChips(s),
      collect: (s) => {
        ans.fabricHates = splitCsv(val(s, "it-hates"));
        return null;
      },
    },
    {
      title: "ALREADY YOURS",
      sub: "Labels and designers already in your life. The starting point matters.",
      body: () => `
        <label class="ilbl" for="it-labels">LABELS YOU OWN AND WEAR <span class="dim">· comma separated, optional</span></label>
        <input id="it-labels" value="${esc(ans.labelsOwned.join(", "))}" />`,
      collect: (s) => {
        ans.labelsOwned = splitCsv(val(s, "it-labels"));
        return null;
      },
    },
    {
      title: "THE CHANGE",
      sub: "One honest answer.",
      body: () => `
        <label class="ilbl" for="it-change">WHAT DO YOU WANT TO CHANGE MOST ABOUT YOUR AESTHETIC?</label>
        <textarea id="it-change" rows="4" maxlength="2000">${esc(ans.changeMost ?? "")}</textarea>`,
      collect: (s) => {
        ans.changeMost = val(s, "it-change");
        return ans.changeMost ? null : "This one can't be skipped — it's why you're here.";
      },
    },
    {
      title: "ONE YEAR OUT",
      sub: "Picture yourself after a year with MONOLITH. Answer from inside that picture.",
      body: () => `
        <label class="ilbl" for="it-wearing">WHAT ARE YOU WEARING?</label>
        <textarea id="it-wearing" rows="3" maxlength="2000">${esc(ans.yearOutWearing ?? "")}</textarea>
        <label class="ilbl" for="it-words">YOUR STYLE, IN A FEW WORDS <span class="dim">· comma separated, up to 10</span></label>
        <input id="it-words" value="${esc((ans.yearOutStyleWords ?? []).join(", "))}" />
        ${chipRowHtml("it-words", ["minimal", "architectural", "monochrome", "utilitarian", "tailored", "avant-garde", "quiet"])}
        <label class="ilbl" for="it-streets">WHOSE CITY STREETS ARE YOU WALKING?</label>
        <input id="it-streets" maxlength="120" value="${esc(ans.yearOutCity ?? "")}" />
        <label class="ilbl" for="it-who">WHO ARE YOU?</label>
        <textarea id="it-who" rows="3" maxlength="2000">${esc(ans.yearOutIdentity ?? "")}</textarea>`,
      wire: (s) => wireChips(s),
      collect: (s) => {
        ans.yearOutWearing = val(s, "it-wearing");
        ans.yearOutStyleWords = splitCsv(val(s, "it-words")).slice(0, 10);
        ans.yearOutCity = val(s, "it-streets");
        ans.yearOutIdentity = val(s, "it-who");
        if (!ans.yearOutWearing) return "Describe what you're wearing a year from now.";
        if (ans.yearOutStyleWords.length === 0) return "Give your style at least one word.";
        if (!ans.yearOutIdentity) return "Who are you in that picture?";
        return null;
      },
    },
    {
      title: "THE CEILING",
      sub: "Desire is honored inside a number. Set the number.",
      body: () => `
        <label class="ilbl" for="it-budget">MONTHLY CLOTHING BUDGET · USD</label>
        <input id="it-budget" type="number" min="1" step="10" value="${ans.monthlyBudgetUsd ?? ""}" />
        <div class="ichoice" id="it-stop" style="margin-top:14px">
          <button class="ghost stopb ${ans.budgetHardStop ? "picked" : ""}" data-v="1">GATE · REFUSE OVER BUDGET</button>
          <button class="ghost stopb ${ans.budgetHardStop ? "" : "picked"}" data-v="0">ADVISORY · WARN ONLY</button>
        </div>
        <p class="dim istep-note">The gate is the product. You can soften it later; strangers usually don't.</p>`,
      wire: (s) => {
        s.querySelectorAll<HTMLButtonElement>(".stopb").forEach((b) =>
          b.addEventListener("click", () => {
            ans.budgetHardStop = b.dataset.v === "1";
            s.querySelectorAll(".stopb").forEach((x) => x.classList.toggle("picked", x === b));
          }),
        );
      },
      collect: (s) => {
        ans.monthlyBudgetUsd = num(s, "it-budget");
        return Number.isFinite(ans.monthlyBudgetUsd) && ans.monthlyBudgetUsd > 0
          ? null
          : "A monthly ceiling is required. It can be generous; it cannot be absent.";
      },
    },
    {
      title: "READ BACK",
      sub: "This is who MONOLITH will hold you to. All of it is editable later.",
      body: () => `
        <div class="ireview">
          <div><span class="dim">NAME</span> ${esc(ans.name)}</div>
          <div><span class="dim">CITY</span> ${esc(ans.location.city)}, ${esc(ans.location.region)}</div>
          <div><span class="dim">RUNS</span> ${esc(ans.thermal)}${ans.sweats ? " · sweats through layers" : ""}</div>
          <div><span class="dim">LOVES</span> ${esc(ans.fabricLoves.join(", ") || "—")}</div>
          <div><span class="dim">NEVER</span> ${esc(ans.fabricHates.join(", ") || "—")}</div>
          <div><span class="dim">THE CHANGE</span> ${esc(ans.changeMost)}</div>
          <div><span class="dim">YEAR OUT</span> ${esc(ans.yearOutStyleWords.join(" · "))} · ${esc(ans.yearOutCity || "your own streets")}</div>
          <div><span class="dim">CEILING</span> ${usd(ans.monthlyBudgetUsd)}/mo · ${ans.budgetHardStop ? "gated" : "advisory"}</div>
        </div>`,
      collect: () => null,
    },
  ];

  let step = 0;
  const render = () => {
    const s = steps[step]!;
    view.innerHTML = "";
    const scope = el(`
      <div class="intake">
        <div class="istep-count">${String(step + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}</div>
        <h2 class="ititle">${s.title}</h2>
        <p class="isub">${s.sub}</p>
        <div class="ibody">${s.body()}</div>
        <div class="ierr" id="it-err"></div>
        <div class="inav">
          ${step > 0 ? `<button class="ghost" id="it-back">BACK</button>` : `<span></span>`}
          <button class="cta" id="it-next">${step === steps.length - 1 ? "BEGIN" : "NEXT"}</button>
        </div>
      </div>`);
    view.appendChild(scope);
    s.wire?.(scope);
    scope.querySelector("#it-back")?.addEventListener("click", () => {
      s.collect(scope); // keep whatever they typed
      step--;
      render();
    });
    scope.querySelector("#it-next")!.addEventListener("click", async () => {
      const err = s.collect(scope);
      const errEl = scope.querySelector("#it-err")!;
      if (err) {
        errEl.textContent = err;
        return;
      }
      errEl.textContent = "";
      if (step < steps.length - 1) {
        step++;
        render();
        window.scrollTo(0, 0);
        return;
      }
      // Final: build the payload the server's IntakeSchema expects.
      const btn = scope.querySelector("#it-next") as HTMLButtonElement;
      btn.disabled = true;
      try {
        await api("/api/intake", {
          method: "POST",
          body: JSON.stringify({
            name: ans.name,
            demographics: ans.demographics || undefined,
            location: ans.location,
            heightIn: ans.heightIn,
            weightLb: ans.weightLb,
            chestIn: ans.chestIn,
            waistIn: ans.waistIn,
            shoeUs: ans.shoeUs,
            shoeWidth: ans.shoeWidth,
            thermal: ans.thermal,
            sweats: ans.sweats,
            fabricLoves: ans.fabricLoves,
            fabricHates: ans.fabricHates,
            labelsOwned: ans.labelsOwned,
            changeMost: ans.changeMost,
            yearOutWearing: ans.yearOutWearing,
            yearOutStyleWords: ans.yearOutStyleWords,
            yearOutCity: ans.yearOutCity,
            yearOutIdentity: ans.yearOutIdentity,
            monthlyBudgetUsd: ans.monthlyBudgetUsd,
            budgetHardStop: ans.budgetHardStop,
          }),
        });
        document.body.classList.remove("gate-mode");
        toast("MONOLITH knows who you're becoming.");
        boot();
      } catch (e) {
        btn.disabled = false;
        errEl.textContent = String((e as Error).message);
      }
    });
  };
  render();
}

const renderers: Record<Tab, () => void | Promise<void>> = {
  verdict: renderVerdictSurface,
  size: renderSize,
  vault: renderVault,
  capital: renderCapital,
};

document.querySelectorAll<HTMLButtonElement>("#tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    // Tapping VERDICT always lands on the home view: a predictable "home"
    // even when a quest detail was left open.
    if (btn.dataset.tab === "verdict") openQuestId = null;
    currentTab = btn.dataset.tab as Tab;
    document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("active", b === btn));
    window.scrollTo(0, 0); // never land mid-page on a new tab
    renderers[currentTab]();
  });
});

async function boot(): Promise<void> {
  // How do we boot: local single-user, or multi-user behind a session?
  let auth: any = { multiuser: false };
  try {
    auth = await api("/api/auth/config");
    // Hosted users are not the server operator: copy that says "edit .env"
    // is for the local single-user install only.
    hostedMultiuser = Boolean(auth.multiuser) && !auth.fakeAuth;
  } catch (e) {
    // Only a missing endpoint (older/local server) may fall back to the
    // ungated single-user path; any other failure stops here rather than
    // booting a UI whose every call will fail or leak past the gate.
    if (!String((e as Error).message).startsWith("404")) {
      renderAuthPanel(`<div class="gate-copy">MONOLITH IS UNREACHABLE<br><span class="dim">${esc((e as Error).message)}. Reload to retry.</span></div>`);
      return;
    }
  }
  if (auth.multiuser) {
    if (auth.fakeAuth) {
      mountAccountControls({ user: readFakeUser() });
    } else {
      if (!auth.clerkPublishableKey || !(await ensureClerkSession(auth.clerkPublishableKey))) return;
      mountAccountControls(null);
    }
  }

  let p: any = null;
  try {
    p = await api("/api/profile");
  } catch (e) {
    if (auth.multiuser) {
      // Signed in but the account can't load: stop at a plain error
      // instead of rendering a nonfunctional shell.
      renderAuthPanel(`<div class="gate-copy">YOUR ACCOUNT DID NOT LOAD<br><span class="dim">${esc((e as Error).message)}. Reload to retry.</span></div>`);
      return;
    }
    toast(String((e as Error).message));
  }
  if (p?.needsIntake) {
    renderIntake();
    return;
  }
  document.body.classList.remove("gate-mode");
  profile = p?.profile ?? null;
  extractionAvailable = p?.extractionAvailable ?? false;
  refreshBudgetStrip();
  renderVerdictSurface();
  scheduleWearPrompt();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

boot();
