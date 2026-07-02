import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { verifyJwt, AuthError } from "@naelao/auth";
import { verifyHmac, signHmac } from "@naelao/crypto";
import type { NaelaoJwtClaims } from "@naelao/types";
import { unauthorized, forbidden } from "./errors.js";

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

// Mint an x-naelao-internal-token the same way naelao-router's proxyTo does — for any
// worker-to-worker caller that talks to another worker's service binding DIRECTLY (bypassing
// the router, so proxyTo never runs). Payload format matches verifyInternalToken exactly:
// "internal:<tenantId>:<ts>". Callers set both this header AND x-naelao-tenant-id — the
// middleware verifies the token against whatever tenantId the request claims.
export async function mintInternalToken(secret: string, tenantId: string): Promise<string> {
  const ts = Date.now().toString();
  const sig = await signHmac(`internal:${tenantId}:${ts}`, secret);
  return `t=${ts},v1=${sig}`;
}

// Rejects any request whose x-naelao-internal-token does not verify against its own
// x-naelao-tenant-id header — the defense-in-depth backstop for B1 (workers must not be
// directly reachable with forged identity headers even if a workers_dev misconfiguration or a
// missing route slips through). getSecret reads PLATFORM_SECRET from the worker's own env,
// mirroring jwtAuth's pattern. Skip mounting this on routes with their own independent
// signature scheme (e.g. the credential-plaintext resolution token, external webhooks).
export function requireInternalHmac(getSecret: (c: { env: Record<string, string> }) => string) {
  return createMiddleware(async (c, next) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const token = c.req.header("x-naelao-internal-token");
    const secret = getSecret(c as unknown as { env: Record<string, string> });
    const ok = tenantId && (await verifyInternalToken(token, tenantId, secret));
    if (!ok) {
      throw forbidden("Missing or invalid internal token — this endpoint is not directly reachable");
    }
    await next();
  });
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
