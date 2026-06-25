import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { verifyJwt, AuthError } from "@naelao/auth";
import { verifyHmac } from "@naelao/crypto";
import type { NaelaoJwtClaims } from "@naelao/types";
import { unauthorized } from "./errors.js";

// Keep Context import used for module augmentation below
type _CtxRef = Context;

// Attach request ID to every request
export const requestId = createMiddleware(async (c, next) => {
  const id = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.res.headers.set("x-request-id", id);
});

// Hono context variable types
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    claims: NaelaoJwtClaims;
    jwtSecret: string;
  }
}

// G-I01: Verify inter-worker HMAC token from x-naelao-internal-token header
// Format: t=<timestamp>,v1=<hmac-hex>
// Rejects tokens older than 60 seconds.
export async function verifyInternalToken(header: string | undefined, tenantId: string, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const ts = parts["t"];
  const sig = parts["v1"];
  if (!ts || !sig) return false;
  const age = Math.abs(Date.now() - parseInt(ts, 10));
  if (age > 60_000) return false;
  return verifyHmac(`internal:${tenantId}:${ts}`, sig, secret);
}

// JWT verification middleware — expects Authorization: Bearer <token>
export function jwtAuth(getSecret: (c: { env: Record<string, string> }) => string) {
  return createMiddleware(async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      throw unauthorized("Missing or invalid Authorization header");
    }
    const token = authHeader.slice(7);
    try {
      const secret = getSecret(c as unknown as { env: Record<string, string> });
      const claims = await verifyJwt(token, secret);
      c.set("claims", claims);
      await next();
    } catch (err) {
      if (err instanceof AuthError) {
        throw unauthorized(err.message);
      }
      throw err;
    }
  });
}
