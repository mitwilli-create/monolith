// LLM extraction: the ONLY place the model is trusted, and only with
// perception (turning a product page into structured fields). Verdicts stay
// deterministic. Structured outputs guarantee the shape; "unknown" is legal.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ANTHROPIC_API_KEY, MODEL } from "./config.js";
import { assertPublicHttpUrl } from "./netguard.js";
import type { Candidate, Category } from "./types.js";
import { CATEGORIES } from "./types.js";

const ExtractionSchema = z.object({
  brand: z.string(),
  name: z.string(),
  category: z.enum(["outerwear", "tops", "bottoms", "footwear", "accessories"]),
  priceUsd: z
    .number()
    .nullable()
    .describe("Current listed price in USD. null if not visible or not in USD without a stated conversion."),
  materials: z
    .array(z.string())
    .describe("Material composition as listed, lowercase, e.g. ['100% waxed cotton', 'calfskin leather']. Empty if not stated. Never guess."),
  fitDescriptors: z
    .array(z.string())
    .describe("Fit language verbatim from the page, lowercase: 'slim fit', 'oversized', 'drop-crotch', etc."),
  descriptionText: z
    .string()
    .describe("2-4 sentence factual condensation of the product description. No marketing adjectives you cannot source from the page."),
  digest: z
    .string()
    .describe("2-3 sentence plain-language description of what this product IS, written for someone comparing options: construction, carry options, hardware, lining, closures, notable design details. Neutral catalog voice sourced from the page only: no opinions, no recommendation, no superlatives the page does not state."),
  attributes: z
    .object({
      itemType: z
        .string()
        .nullable()
        .describe("What the product is, lowercase: 'tote bag', 'messenger bag', 'chelsea boot'. null if unclear."),
      colors: z
        .array(z.string())
        .describe("Colors of THIS listing/variant as stated, lowercase: ['black']. Empty if not stated."),
      shellMaterials: z
        .array(z.string())
        .describe("Outer/primary construction materials, lowercase, normalized to the base material: 'full grain leather' → ['full grain leather', 'leather']. Empty if not stated."),
      liningMaterials: z
        .array(z.string())
        .describe("Interior/lining materials, lowercase. 'microsuede' and 'ultrasuede' are synthetic lining fabrics, NOT suede: list them verbatim. Empty if not stated."),
      carryModes: z
        .array(z.string())
        .describe("Distinct ways the page says it can be carried/worn, lowercase, from: 'top handle', 'shoulder', 'crossbody', 'backpack', 'hand', 'belt'. Empty for non-bags or when not stated."),
      laptopFit: z
        .boolean()
        .nullable()
        .describe("true only if the page states a laptop/computer/tablet-of-laptop-size fits (sleeve, compartment, or dimensions callout). null when the page is silent."),
      visibleBranding: z
        .boolean()
        .nullable()
        .describe("true = exterior logo/monogram/wordmark visible per page text or product images described; false = page states minimal/no branding or describes an unbranded exterior. null when indeterminable."),
      aestheticDescriptors: z
        .array(z.string())
        .describe("Style adjectives the page itself uses, lowercase, verbatim: 'minimalist', 'architectural', 'sleek', 'utilitarian', 'classic'. Empty if the page uses none."),
    })
    .describe("Structured product attributes. Report only what the page supports; null/empty are correct answers."),
  platform: z
    .string()
    .nullable()
    .describe("Retailer/platform name, e.g. 'Farfetch', 'SSENSE', or the brand's own store."),
  confidence: z.enum(["high", "medium", "low"]),
  missing: z
    .array(z.string())
    .describe("Fields you could not determine from the page."),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

export function extractionAvailable(): boolean {
  return ANTHROPIC_API_KEY.length > 0;
}

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2_000_000;

/**
 * Fetch a product page server-side and reduce it to text the model can read.
 * SSRF-guarded (Qodo finding 1): every hop is validated against public-address
 * rules, redirects are followed manually with a hop cap, and the body read is
 * size-capped instead of buffering arbitrary responses.
 */
export async function fetchPageText(url: string): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(current, {
        signal: controller.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
        },
        redirect: "manual",
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`Redirect ${res.status} without location.`);
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`);
      const ct = res.headers.get("content-type") ?? "";
      if (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct)) {
        throw new Error(`Unsupported content-type: ${ct.split(";")[0]}`);
      }
      const html = await readCapped(res, MAX_RESPONSE_BYTES);
      return htmlToText(html).slice(0, 60_000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects.");
}

/** Read at most `maxBytes` of a response body. Never buffers unbounded input. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  out += decoder.decode();
  return out;
}

export function htmlToText(html: string): string {
  // Keep JSON-LD product blocks intact. They usually carry price + materials.
  const jsonLd = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )]
    .map((m) => m[1]!.trim())
    .filter((s) => /product/i.test(s))
    .join("\n");

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  return jsonLd ? `STRUCTURED PRODUCT DATA:\n${jsonLd}\n\nPAGE TEXT:\n${text}` : text;
}

export async function extractCandidate(input: {
  url?: string;
  pageText?: string;
}): Promise<{ extraction: Extraction; candidate: Candidate }> {
  if (!extractionAvailable()) {
    throw new Error(
      "ANTHROPIC_API_KEY not configured. Use manual entry, or add the key to .env.",
    );
  }
  // Blank pageText counts as "not provided". A client sending
  // { url, pageText: "" } should fall through to the URL fetch (Qodo r3).
  const provided =
    typeof input.pageText === "string" && input.pageText.trim().length > 0
      ? input.pageText
      : undefined;
  // Hard cap regardless of source. Fetched pages are already capped, and
  // manual pageText must not be able to blow up the prompt (Qodo r2 finding 2).
  const raw = provided ?? (input.url ? await fetchPageText(input.url) : "");
  const pageText = raw.slice(0, 60_000);
  if (!pageText.trim()) throw new Error("No page content to extract from.");

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system:
      "You extract structured product data from fashion e-commerce pages. " +
      "Report only what the page states. Never infer materials, prices, or fit language that is not present: " +
      "empty arrays and null are correct answers for absent data. List everything you could not determine in `missing`.",
    messages: [
      {
        role: "user",
        content: `Extract the product data from this page:\n\n${pageText}`,
      },
    ],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });

  const extraction = response.parsed_output;
  if (!extraction) throw new Error("Extraction failed to parse.");

  const candidate: Candidate = {
    url: input.url,
    brand: extraction.brand,
    name: extraction.name,
    category: normalizeCategory(extraction.category),
    priceUsd: extraction.priceUsd,
    materials: extraction.materials.map((m) => m.toLowerCase()),
    fitDescriptors: extraction.fitDescriptors.map((f) => f.toLowerCase()),
    descriptionText: extraction.descriptionText,
    digest: extraction.digest || undefined,
    platform: extraction.platform ?? undefined,
    attributes: {
      itemType: extraction.attributes.itemType?.toLowerCase() ?? null,
      colors: extraction.attributes.colors.map((s) => s.toLowerCase()),
      shellMaterials: extraction.attributes.shellMaterials.map((s) => s.toLowerCase()),
      liningMaterials: extraction.attributes.liningMaterials.map((s) => s.toLowerCase()),
      carryModes: extraction.attributes.carryModes.map((s) => s.toLowerCase()),
      laptopFit: extraction.attributes.laptopFit,
      visibleBranding: extraction.attributes.visibleBranding,
      aestheticDescriptors: extraction.attributes.aestheticDescriptors.map((s) => s.toLowerCase()),
    },
  };
  return { extraction, candidate };
}

function normalizeCategory(c: string): Category {
  const lc = c.toLowerCase() as Category;
  return CATEGORIES.includes(lc) ? lc : "tops";
}
