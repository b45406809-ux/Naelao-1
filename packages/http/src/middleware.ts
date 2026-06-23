import { createMiddleware } from "hono/factory";
import { verifyJwt, AuthError } from "@naelao/auth";
import type { NaelaoJwtClaims } from "@naelao/types";
import { unauthorized } from "./errors.js";

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
