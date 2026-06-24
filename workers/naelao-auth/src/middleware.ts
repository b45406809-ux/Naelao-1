import type { Context, MiddlewareHandler } from 'hono';
import { verifyJWT, type JWTPayload } from './jwt';

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';

interface Env {
  NAELAO_JWT_SECRET: string;
  NAELAO_CONFIG_KV: KVNamespace;
}

declare module 'hono' {
  interface ContextVariableMap {
    jwt: JWTPayload;
  }
}

export function authMiddleware(env: Env): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } },
        401
      );
    }

    const token = auth.slice(7);
    let payload: JWTPayload;

    try {
      payload = await verifyJWT(token, env.NAELAO_JWT_SECRET);
    } catch {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' } },
        401
      );
    }

    const revokedKey = `revoked:${payload.sub}:${payload.spaceId}`;
    const revoked = await env.NAELAO_CONFIG_KV.get(revokedKey);
    if (revoked !== null) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Session revoked' } },
        401
      );
    }

    c.set('jwt', payload);
    await next();
  };
}

export function requireRole(...roles: MemberRole[]): MiddlewareHandler {
  return async (c, next) => {
    const jwt = c.get('jwt');
    if (!jwt || !roles.includes(jwt.role as MemberRole)) {
      return c.json(
        { error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
        403
      );
    }
    await next();
  };
}
