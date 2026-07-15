// Multi-user session gate. Clerk owns identity (managed auth, hosted
// sign-in UI); this middleware only VERIFIES the session on each request —
// stateless per request, no server-side session store — and pins the
// resolved userId onto the request context that store.ts reads. Everything
// below the gate is unchanged single-user code operating on that user's
// own data directory.

import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { createClerkClient } from "@clerk/backend";
import {
  CLERK_AUTHORIZED_PARTIES,
  CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY,
  FAKE_AUTH,
  MULTIUSER,
} from "./config.js";
import { runAsUser } from "./user-context.js";

const clerk = CLERK_SECRET_KEY
  ? createClerkClient({
      secretKey: CLERK_SECRET_KEY,
      publishableKey: CLERK_PUBLISHABLE_KEY,
    })
  : null;

function unauthenticated(c: Context): Response {
  return c.json({ ok: false, error: "Sign in required.", unauthenticated: true }, 401);
}

/**
 * Require a signed-in user on every /api route. Session arrives as Clerk's
 * __session cookie (browser navigations — including the Gmail OAuth
 * callback redirect — and same-origin fetches) or an Authorization header;
 * authenticateRequest handles both.
 */
export async function requireUser(c: Context, next: Next): Promise<Response | void> {
  if (!MULTIUSER) return next();

  if (FAKE_AUTH) {
    // Dev stand-in (config.ts refuses this alongside real keys): attribute
    // the request to the fake-user cookie so isolation and intake can be
    // exercised end to end without a Clerk account.
    const raw = getCookie(c, "monolith-fake-user") || "demo";
    const fakeId = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "demo";
    return runAsUser(`fake_${fakeId}`, () => next());
  }

  const state = await clerk!.authenticateRequest(c.req.raw, {
    authorizedParties: CLERK_AUTHORIZED_PARTIES.length ? CLERK_AUTHORIZED_PARTIES : undefined,
  });
  if (!state.isAuthenticated) return unauthenticated(c);
  const auth = state.toAuth();
  if (!auth.userId) return unauthenticated(c);
  return runAsUser(auth.userId, () => next());
}
