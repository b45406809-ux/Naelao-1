import type { MiddlewareHandler } from 'hono';

interface Env {
  NAELAO_AUTH: Fetcher;
  NAELAO_CIRCUIT_KV: KVNamespace;
}

interface JWTPayload {
  sub: string;
  spaceId: string;
  role: string;
  exp: number;
  plan?: string;
}

export function authMiddleware(env: Env): MiddlewareHandler<{ Bindings: Env; Variables: { jwt?: JWTPayload } }> {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } }, 401);
    }

    const meResp = await env.NAELAO_AUTH.fetch(new Request('https://placeholder/v1/auth/me', {
      headers: { Authorization: authHeader },
    }));

    if (!meResp.ok) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }, 401);
    }

    const data = await meResp.json<{ data?: JWTPayload }>();
    if (!data.data) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token payload' } }, 401);
    }

    const jwt = data.data;
    const revokedKey = 'revoked:' + jwt.sub + ':' + jwt.spaceId;
    const revoked = await env.NAELAO_CIRCUIT_KV.get(revokedKey);
    if (revoked) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Session revoked' } }, 401);
    }

    c.set('jwt', jwt);
    await next();
  };
}

export function requireRole(...roles: string[]): MiddlewareHandler<{ Variables: { jwt?: JWTPayload } }> {
  return async (c, next) => {
    const jwt = c.get('jwt') as JWTPayload | undefined;
    if (!jwt || !roles.includes(jwt.role)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Insufficient role' } }, 403);
    }
    await next();
  };
}
