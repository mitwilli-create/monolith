import { describe, expect, it } from "vitest";
import {
  consumeOauthState,
  gmailMessageToText,
  looksLikeOrderEmail,
  newOauthState,
  proposalDupKey,
  proposalsFromExtraction,
  proposalToItem,
  type OrderExtraction,
} from "../src/ingest.js";
import { protocols } from "./fixtures.js";
import type { IngestProposal } from "../src/types.js";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function gmailMessage(opts: {
  from?: string;
  subject?: string;
  date?: string;
  plain?: string;
  html?: string;
}): any {
  const parts: any[] = [];
  if (opts.plain !== undefined) {
    parts.push({ mimeType: "text/plain", body: { data: b64url(opts.plain) } });
  }
  if (opts.html !== undefined) {
    parts.push({ mimeType: "text/html", body: { data: b64url(opts.html) } });
  }
  return {
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: opts.from ?? "orders@ssense.com" },
        { name: "Subject", value: opts.subject ?? "Your order is confirmed" },
        { name: "Date", value: opts.date ?? "Mon, 13 Jul 2026 18:04:00 -0700" },
      ],
      parts,
    },
  };
}

describe("gmailMessageToText", () => {
  it("prefers plain text and reads headers", () => {
    const email = gmailMessageToText(gmailMessage({
      plain: "Order #123: Rick Owens Geobasket, $900, size 43.",
      html: "<p>ignored when plain exists</p>",
    }));
    expect(email.text).toContain("Geobasket");
    expect(email.text).not.toContain("ignored");
    expect(email.from).toBe("orders@ssense.com");
    expect(email.subject).toBe("Your order is confirmed");
    expect(email.receivedAt).toBe("2026-07-14"); // UTC date of the Date header
  });

  it("falls back to stripped HTML when there is no plain part", () => {
    const email = gmailMessageToText(gmailMessage({
      html: "<html><script>junk()</script><body><h1>Order confirmed</h1><p>1x Chelsea Boot — $420</p></body></html>",
    }));
    expect(email.text).toContain("Chelsea Boot");
    expect(email.text).toContain("$420");
    expect(email.text).not.toContain("junk");
  });

  it("walks nested multipart trees", () => {
    const msg = {
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "Receipt" }],
        parts: [{
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64url("deep part") } }],
        }],
      },
    };
    expect(gmailMessageToText(msg).text).toBe("deep part");
  });

  it("survives a message with no body and no date", () => {
    const email = gmailMessageToText({ payload: { headers: [] } });
    expect(email.text).toBe("");
    expect(email.receivedAt).toBeNull();
  });
});

describe("looksLikeOrderEmail", () => {
  it("passes order confirmations", () => {
    expect(looksLikeOrderEmail("Your order is confirmed", "x@shop.com")).toBe(true);
    expect(looksLikeOrderEmail("Receipt for purchase #4411", "billing@store.io")).toBe(true);
    expect(looksLikeOrderEmail("Your package has shipped", "no-reply@carrier.com")).toBe(true);
  });

  it("rejects marketing even when it name-drops orders", () => {
    expect(looksLikeOrderEmail("Don't leave your cart behind!", "promo@shop.com")).toBe(false);
    expect(looksLikeOrderEmail("SALE: 40% off everything", "promo@shop.com")).toBe(false);
    expect(looksLikeOrderEmail("Back in stock: the boot you wanted", "news@shop.com")).toBe(false);
  });

  it("errs open on order-ish senders with neutral subjects", () => {
    expect(looksLikeOrderEmail("SSENSE", "orders@ssense.com")).toBe(true);
    expect(looksLikeOrderEmail("Hi", "friend@gmail.com")).toBe(false);
  });

  it("passes exchange confirmations (a replacement piece is incoming)", () => {
    expect(looksLikeOrderEmail("Your exchange has been processed", "help@lr3.com")).toBe(true);
  });
});

const extraction: OrderExtraction = {
  isApparelOrder: true,
  merchant: "SSENSE",
  orderRef: "SS-1188",
  orderDate: "2026-07-10",
  items: [
    {
      brand: "Rick Owens",
      name: "Geobasket High-Top Sneakers",
      category: "footwear",
      priceUsd: 900,
      sizeLabel: "43",
      colors: ["Black"],
      materials: ["Calfskin Leather"],
    },
    {
      brand: null,
      name: "Wool Beanie",
      category: null,
      priceUsd: null,
      sizeLabel: null,
      colors: [],
      materials: [],
    },
  ],
  confidence: "high",
};

const source = {
  messageId: "m1",
  from: "orders@ssense.com",
  subject: "Your order is confirmed",
  receivedAt: "2026-07-10",
};

describe("proposalsFromExtraction", () => {
  it("quarantines one proposal per line item, lowercased, status proposed", () => {
    const ps = proposalsFromExtraction(extraction, source, "mitchell");
    expect(ps).toHaveLength(2);
    expect(ps[0]!.status).toBe("proposed");
    expect(ps[0]!.item.colors).toEqual(["black"]);
    expect(ps[0]!.item.materials).toEqual(["calfskin leather"]);
    expect(ps[0]!.merchant).toBe("SSENSE");
    expect(ps[1]!.item.brand).toBeNull(); // unknown stays unknown
  });

  it("produces nothing for non-apparel orders regardless of items", () => {
    expect(proposalsFromExtraction({ ...extraction, isApparelOrder: false }, source, "mitchell")).toHaveLength(0);
  });

  it("drops nameless line items", () => {
    const ps = proposalsFromExtraction(
      { ...extraction, items: [{ ...extraction.items[0]!, name: "  " }] },
      source,
      "mitchell",
    );
    expect(ps).toHaveLength(0);
  });
});

function proposal(overrides: Partial<IngestProposal["item"]> = {}): IngestProposal {
  return {
    id: "ing_1",
    profileId: "mitchell",
    at: "2026-07-14T10:00:00.000Z",
    source,
    merchant: "SSENSE",
    orderRef: "SS-1188",
    orderDate: "2026-07-10",
    item: {
      brand: "Rick Owens",
      name: "Geobasket High-Top Sneakers",
      category: "footwear",
      priceUsd: 900,
      sizeLabel: "43",
      colors: ["black"],
      materials: ["calfskin leather"],
      ...overrides,
    },
    confidence: "high",
    status: "proposed",
  };
}

describe("proposalDupKey — one proposal per real-world line item", () => {
  it("keys on merchant + order ref + item name, case-insensitive", () => {
    const a = proposalDupKey({ merchant: "SSENSE", orderRef: "SS-1188", item: { name: "Geobasket" } });
    const b = proposalDupKey({ merchant: "ssense", orderRef: "ss-1188", item: { name: "GEOBASKET" } });
    expect(a).toBe(b);
  });

  it("a thread of order emails collapses; different items in one order do not", () => {
    const cuff = { merchant: "Traces Palestine", orderRef: "#1329", item: { name: "The Heritage Grid Cuff" } };
    expect(proposalDupKey(cuff)).toBe(proposalDupKey({ ...cuff }));
    expect(proposalDupKey(cuff)).not.toBe(
      proposalDupKey({ ...cuff, item: { name: "Keffiyeh Scarf" } }),
    );
  });

  it("no order ref → no key: same-name repeats stay separate", () => {
    expect(proposalDupKey({ merchant: "COS", orderRef: null, item: { name: "Wool Beanie" } })).toBeNull();
  });
});

describe("proposalToItem — the only doorway into state, and it is code", () => {
  it("converts a confirmed proposal into a vault item with care protocols", () => {
    const { item, ledger } = proposalToItem(proposal(), { recordSpend: true }, protocols);
    expect(item.brand).toBe("Rick Owens");
    expect(item.category).toBe("footwear");
    expect(item.priceUsd).toBe(900);
    expect(item.acquiredAt).toBe("2026-07-10"); // order date wins
    expect(item.wearCount).toBe(0);
    expect(item.careProtocolIds).toContain("leather-condition");
    expect(item.notes).toContain("SSENSE");
    expect(item.notes).toContain("SS-1188");
    expect(ledger).not.toBeNull();
    expect(ledger!.amountUsd).toBe(900);
    expect(ledger!.date).toBe("2026-07-10"); // spend lands in the order's month
    expect(ledger!.platform).toBe("SSENSE");
  });

  it("requires a category: extracted null + no override throws", () => {
    expect(() => proposalToItem(proposal({ category: null }), {}, protocols)).toThrow(/category/i);
    const { item } = proposalToItem(proposal({ category: null }), { category: "accessories" }, protocols);
    expect(item.category).toBe("accessories");
  });

  it("falls back brand → merchant, and requires one of them", () => {
    const { item } = proposalToItem(proposal({ brand: null }), {}, protocols);
    expect(item.brand).toBe("SSENSE");
    const orphan = { ...proposal({ brand: null }), merchant: null };
    expect(() => proposalToItem(orphan, {}, protocols)).toThrow(/brand/i);
  });

  it("never writes a ledger entry without an explicit recordSpend or a price", () => {
    expect(proposalToItem(proposal(), {}, protocols).ledger).toBeNull();
    expect(proposalToItem(proposal({ priceUsd: null }), { recordSpend: true }, protocols).ledger).toBeNull();
  });

  it("applies the owner's edits over extraction", () => {
    const { item } = proposalToItem(proposal(), {
      brand: "Rick Owens DRKSHDW",
      priceUsd: 720,
      materials: ["Canvas"],
    }, protocols);
    expect(item.brand).toBe("Rick Owens DRKSHDW");
    expect(item.priceUsd).toBe(720);
    expect(item.materials).toEqual(["canvas"]);
    expect(item.careProtocolIds).not.toContain("leather-condition");
  });
});

describe("oauth state — the callback's only authentication", () => {
  it("binds the state to the user who started the flow", () => {
    const state = newOauthState("user_abc");
    expect(consumeOauthState(state)).toEqual({ valid: true, userId: "user_abc" });
  });

  it("carries a null user for single-user local mode", () => {
    const state = newOauthState(null);
    expect(consumeOauthState(state)).toEqual({ valid: true, userId: null });
  });

  it("is single-use", () => {
    const state = newOauthState("user_abc");
    consumeOauthState(state);
    expect(consumeOauthState(state)).toEqual({ valid: false });
  });

  it("rejects states it never minted", () => {
    expect(consumeOauthState("forged")).toEqual({ valid: false });
    expect(consumeOauthState("")).toEqual({ valid: false });
  });

  it("does not leak one user's state to another flow", () => {
    const a = newOauthState("user_a");
    const b = newOauthState("user_b");
    expect(consumeOauthState(b)).toEqual({ valid: true, userId: "user_b" });
    expect(consumeOauthState(a)).toEqual({ valid: true, userId: "user_a" });
  });
});
