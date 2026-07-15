import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/extract.js";
import { parseInventoryLines, findClashes } from "../src/inventory.js";
import { protocols } from "./fixtures.js";
import type { Item } from "../src/types.js";

describe("htmlToText", () => {
  it("strips tags and scripts but preserves JSON-LD product blocks", () => {
    const html = `
      <html><head>
        <script>var tracking = "junk";</script>
        <script type="application/ld+json">{"@type":"Product","name":"Creatch Cargo","offers":{"price":"890"}}</script>
        <style>.x{color:red}</style>
      </head><body><h1>Rick Owens</h1><p>Drop-crotch cargo pant in cotton twill.</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("STRUCTURED PRODUCT DATA");
    expect(text).toContain('"price":"890"');
    expect(text).toContain("Drop-crotch cargo pant");
    expect(text).not.toContain("tracking");
    expect(text).not.toContain("color:red");
  });
});

describe("Inventory line importer", () => {
  it("parses well-formed lines and auto-assigns protocols", () => {
    const { items, errors } = parseInventoryLines(
      [
        "# comment line",
        "",
        "bottoms | Rick Owens | Creatch Cargo | cotton twill | 890 | 2025-11-29",
        "outerwear | Boris Bidjan Saberi | J1 leather jacket | horsehide leather | $2,400",
        "footwear | Rick Owens | Ramones | canvas, rubber",
      ].join("\n"),
      "mitchell",
      protocols,
    );
    expect(errors).toHaveLength(0);
    expect(items).toHaveLength(3);
    expect(items[0]!.priceUsd).toBe(890);
    expect(items[1]!.priceUsd).toBe(2400);
    expect(items[1]!.careProtocolIds).toContain("leather-condition");
    expect(items[2]!.careProtocolIds).toContain("sneaker-clean");
  });

  it("reports malformed lines without failing the batch", () => {
    const { items, errors } = parseInventoryLines(
      "notacategory | X | Y\njust one field\nbottoms | Vetements | Jeans | denim",
      "mitchell",
      protocols,
    );
    expect(items).toHaveLength(1);
    expect(errors).toHaveLength(2);
  });
});

describe("Clash detection boundaries", () => {
  const owned: Item[] = [{
    id: "i1", profileId: "m", category: "bottoms", brand: "Rick Owens",
    name: "Creatch Cargo Pants", materials: [], colors: [], wearCount: 0, careProtocolIds: [],
  }];

  it("different category never clashes", () => {
    expect(findClashes({ brand: "Rick Owens", category: "tops", name: "Creatch Cargo Pants" }, owned)).toHaveLength(0);
  });

  it("same brand, unrelated model does not clash", () => {
    expect(findClashes({ brand: "Rick Owens", category: "bottoms", name: "Bela Trouser Wool" }, owned)).toHaveLength(0);
  });

  it("near-identical listing clashes", () => {
    expect(findClashes({ brand: "Rick Owens", category: "bottoms", name: "DRKSHDW Creatch Cargo" }, owned)).toHaveLength(1);
  });
});
