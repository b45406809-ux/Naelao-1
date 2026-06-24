import type { MiddlewareHandler } from 'hono';

interface Env {
  NAELAO_CIRCUIT_KV: KVNamespace;
}

interface JWTPayload {
  sub: string;
  role?: string;
  plan?: string;
}

export function rateLimitMiddleware(env: Env): MiddlewareHandler<{ Bindings: Env; Variables: { jwt?: JWTPayload } }> {
  return async (c, next) => {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const jwt = c.get('jwt') as JWTPayload | undefined;

    const isPro = jwt?.plan === 'pro' || jwt?.plan === 'team' || jwt?.plan === 'enterprise';
    const limit = isPro ? 1000 : 100;

    const key = 'rl:api:' + ip;
    const currentStr = await env.NAELAO_CIRCUIT_KV.get(key);
    const current = parseInt(currentStr ?? '0');

    if (current >= limit) {
      return c.json(
        { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
        429,
        { 'Retry-After': '60' }
      );
    }

    await env.NAELAO_CIRCUIT_KV.put(key, String(current + 1), { expirationTtl: 60 });
    await next();
  };
}
