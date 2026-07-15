// Multi-user store isolation (Sprint B). The env is staged BEFORE the
// dynamic imports so config.ts sees a temp data dir and fake-auth
// multi-user mode; vitest's per-file process isolation keeps this from
// leaking into other test files.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "monolith-store-test-"));
process.env.MONOLITH_DATA_DIR = tmpRoot;
process.env.MONOLITH_FAKE_AUTH = "1";

let store: typeof import("../src/store.js");
let ctx: typeof import("../src/user-context.js");

beforeAll(async () => {
  ctx = await import("../src/user-context.js");
  store = await import("../src/store.js");
});

afterAll(() => {
  delete process.env.MONOLITH_DATA_DIR;
  delete process.env.MONOLITH_FAKE_AUTH;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveDataDir (pure)", () => {
  it("routes a user to their own directory", () => {
    const r = store.resolveDataDir("user_abc", true, "/root");
    expect(r).toEqual({ dir: path.join("/root", "users", "user_abc") });
  });

  it("fails closed in multi-user mode without a user context", () => {
    const r = store.resolveDataDir(null, true, "/root");
    expect("error" in r).toBe(true);
  });

  it("is the plain root in single-user local mode", () => {
    expect(store.resolveDataDir(null, false, "/root")).toEqual({ dir: "/root" });
  });

  it("refuses a user id that could escape the directory", () => {
    for (const evil of ["../mitchell", "a/b", "a\\b", "", ".", "x".repeat(200)]) {
      const r = store.resolveDataDir(evil, true, "/root");
      expect("error" in r, `id ${JSON.stringify(evil)} must be refused`).toBe(true);
    }
  });
});

describe("per-user isolation (real fs, fake-auth multiuser)", () => {
  it("two users write the same filename without touching each other", () => {
    ctx.runAsUser("user_alpha", () => {
      store.writeJson("inventory.json", [{ id: "alpha-item" }]);
    });
    ctx.runAsUser("user_beta", () => {
      store.writeJson("inventory.json", [{ id: "beta-item" }]);
    });
    const alpha = ctx.runAsUser("user_alpha", () =>
      store.readJson<any[]>("inventory.json", []),
    );
    const beta = ctx.runAsUser("user_beta", () =>
      store.readJson<any[]>("inventory.json", []),
    );
    expect(alpha).toEqual([{ id: "alpha-item" }]);
    expect(beta).toEqual([{ id: "beta-item" }]);
    // And they physically live in separate directories.
    expect(fs.existsSync(path.join(tmpRoot, "users", "user_alpha", "inventory.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, "users", "user_beta", "inventory.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, "inventory.json"))).toBe(false);
  });

  it("jsonl audit logs are per-user too", () => {
    ctx.runAsUser("user_alpha", () => store.appendJsonl("verdicts.jsonl", { v: 1 }));
    const alpha = ctx.runAsUser("user_alpha", () => store.readJsonl<any>("verdicts.jsonl"));
    const beta = ctx.runAsUser("user_beta", () => store.readJsonl<any>("verdicts.jsonl"));
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(0);
  });

  it("throws (never falls through to a shared dir) without a user context", () => {
    expect(() => store.readJson("inventory.json", [])).toThrow(/user context/i);
    expect(() => store.writeJson("inventory.json", [])).toThrow(/user context/i);
    expect(() => store.appendJsonl("verdicts.jsonl", {})).toThrow(/user context/i);
  });

  it("a new user's directory is seeded with shared knowledge, not a profile", () => {
    ctx.runAsUser("user_fresh", () => store.readJson("profiles.json", null));
    const dir = path.join(tmpRoot, "users", "user_fresh");
    expect(fs.existsSync(path.join(dir, "care-protocols.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "sizing-matrix.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "profiles.json"))).toBe(false);
  });

  it("context does not leak outside runAsUser", () => {
    ctx.runAsUser("user_alpha", () => {});
    expect(ctx.currentUserId()).toBeNull();
  });
});
