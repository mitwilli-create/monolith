import type { Profile } from "./types.js";
import { readJson, writeJson } from "./store.js";

interface ProfilesFile {
  activeProfileId: string;
  profiles: Profile[];
}

const FILE = "profiles.json";

/**
 * No profile on file. In multi-user mode this is a brand-new account whose
 * next stop is the intake flow — server.ts maps it to a 409 the frontend
 * recognizes — not an error in the local sense.
 */
export class NoProfileError extends Error {
  constructor() {
    super("No profile on file yet: complete the intake first.");
  }
}

export function loadProfilesFile(): ProfilesFile {
  return readJson<ProfilesFile>(FILE, { activeProfileId: "", profiles: [] });
}

export function getActiveProfile(): Profile {
  const f = loadProfilesFile();
  const p =
    f.profiles.find((x) => x.id === f.activeProfileId) ?? f.profiles[0];
  if (!p) throw new NoProfileError();
  return p;
}

export function saveProfile(updated: Profile): Profile {
  const f = loadProfilesFile();
  const idx = f.profiles.findIndex((x) => x.id === updated.id);
  if (idx === -1) {
    f.profiles.push(updated);
  } else {
    f.profiles[idx] = updated;
  }
  if (!f.activeProfileId) f.activeProfileId = updated.id;
  writeJson(FILE, f);
  return updated;
}

export function setActiveProfile(id: string): void {
  const f = loadProfilesFile();
  if (!f.profiles.some((p) => p.id === id)) {
    throw new Error(`Unknown profile: ${id}`);
  }
  f.activeProfileId = id;
  writeJson(FILE, f);
}
