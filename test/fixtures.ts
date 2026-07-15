import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CareProtocol, Profile, SizingRule } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const seed = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(here, "..", "seed", name), "utf8"));

export const profile: Profile = seed("profiles.json").profiles[0];
export const sizingMatrix: {
  rules: SizingRule[];
  genericFallback: { recommendation: string; rationale: string; source: string };
} = seed("sizing-matrix.json");
export const protocols: CareProtocol[] = seed("care-protocols.json").protocols;
