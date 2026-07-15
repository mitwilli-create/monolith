import type { CareProtocol, Category, Item } from "./types.js";
import { CATEGORIES } from "./types.js";
import { newId, readJson, writeJson } from "./store.js";

const FILE = "inventory.json";

export function loadInventory(): Item[] {
  return readJson<Item[]>(FILE, []);
}

export function saveInventory(items: Item[]): void {
  writeJson(FILE, items);
}

export function addItem(
  partial: Omit<Item, "id" | "wearCount" | "careProtocolIds"> & {
    wearCount?: number;
    careProtocolIds?: string[];
  },
  protocols: CareProtocol[],
): Item {
  const item: Item = {
    wearCount: 0,
    ...partial,
    id: newId("itm"),
    careProtocolIds:
      partial.careProtocolIds ?? assignProtocols(partial.materials, protocols),
  };
  const items = loadInventory();
  items.push(item);
  saveInventory(items);
  return item;
}

/**
 * Ownership-scoped update (Qodo finding 3): only mutates items belonging to
 * `profileId`, and `id`/`profileId` are immutable regardless of the patch.
 */
export function updateItem(
  id: string,
  profileId: string,
  patch: Partial<Item>,
): Item | null {
  const items = loadInventory();
  const idx = items.findIndex((i) => i.id === id && i.profileId === profileId);
  if (idx === -1) return null;
  const current = items[idx]!;
  const updated: Item = {
    ...current,
    ...patch,
    id: current.id,
    profileId: current.profileId,
  };
  items[idx] = updated;
  saveInventory(items);
  return updated;
}

export function deleteItem(id: string, profileId: string): boolean {
  const items = loadInventory();
  const next = items.filter((i) => !(i.id === id && i.profileId === profileId));
  if (next.length === items.length) return false;
  saveInventory(next);
  return true;
}

/** Auto-assign care protocols by matching item materials against protocol matchers. */
export function assignProtocols(
  materials: string[],
  protocols: CareProtocol[],
): string[] {
  const text = materials.join(" ").toLowerCase();
  return protocols
    .filter((p) => p.materialMatch.some((m) => text.includes(m.toLowerCase())))
    .map((p) => p.id);
}

const STOPWORDS = new Set([
  "the", "a", "in", "with", "and", "of", "for", "mens", "men's", "man",
  "jacket", "pant", "pants", "shirt", "coat", "sneaker", "boot", "tee",
  "black", "white", "grey", "gray",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/**
 * Clash detection for Gate A: same brand + category, with meaningful
 * name-token overlap → the wardrobe already holds this asset.
 */
export function findClashes(
  candidate: { brand: string; category: Category; name: string },
  items: Item[] = loadInventory(),
): Item[] {
  const cb = candidate.brand.toLowerCase().trim();
  const ct = tokens(candidate.name);
  return items.filter((item) => {
    if (item.category !== candidate.category) return false;
    const ib = item.brand.toLowerCase().trim();
    if (!(ib.includes(cb) || cb.includes(ib))) return false;
    const it = tokens(item.name);
    if (ct.size === 0 || it.size === 0) return false;
    let overlap = 0;
    for (const t of ct) if (it.has(t)) overlap++;
    const ratio = overlap / Math.min(ct.size, it.size);
    return ratio >= 0.5;
  });
}

/**
 * Line-format importer for Inventory_Live.txt-style ledgers.
 * Format per line: category | brand | name | materials(comma) | price? | acquired?(YYYY-MM-DD)
 * Lines starting with # and blank lines are skipped.
 */
export function parseInventoryLines(
  text: string,
  profileId: string,
  protocols: CareProtocol[],
): { items: Omit<Item, "id">[]; errors: string[] } {
  const items: Omit<Item, "id">[] = [];
  const errors: string[] = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) {
      errors.push(`Line ${n + 1}: expected at least "category | brand | name"`);
      continue;
    }
    const category = parts[0]!.toLowerCase() as Category;
    if (!CATEGORIES.includes(category)) {
      errors.push(`Line ${n + 1}: unknown category "${parts[0]}"`);
      continue;
    }
    const materials = (parts[3] ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const price = parts[4] ? Number.parseFloat(parts[4].replace(/[$,]/g, "")) : undefined;
    items.push({
      profileId,
      category,
      brand: parts[1]!,
      name: parts[2]!,
      materials,
      colors: [],
      priceUsd: Number.isFinite(price) ? price : undefined,
      acquiredAt: parts[5],
      wearCount: 0,
      careProtocolIds: assignProtocols(materials, protocols),
    });
  }
  return { items, errors };
}
