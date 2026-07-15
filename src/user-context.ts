// Per-request user identity, carried on AsyncLocalStorage so the store
// layer can resolve the caller's data directory without threading a user
// id through every module. Deliberately dependency-free (store.ts and
// config.ts both import it; anything heavier would risk a cycle).

import { AsyncLocalStorage } from "node:async_hooks";

export interface UserContext {
  userId: string;
}

const als = new AsyncLocalStorage<UserContext>();

/** The authenticated user for the current request, or null outside one
 *  (startup, tests, single-user local mode). */
export function currentUserId(): string | null {
  return als.getStore()?.userId ?? null;
}

/** Run `fn` (and everything it awaits) as `userId`. */
export function runAsUser<T>(userId: string, fn: () => T): T {
  return als.run({ userId }, fn);
}
