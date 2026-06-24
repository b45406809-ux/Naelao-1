import type { MiddlewareHandler } from 'hono';

interface Env {
  ENVIRONMENT: string;
}

const ALLOWED_ORIGINS_BASE = ['https://app.naelao.com', 'https://naelao.com'];

export function corsMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.req.header('Origin') ?? '';
    const env = c.env;

    const allowedOrigins = [
      ...ALLOWED_ORIGINS_BASE,
      ...(env.ENVIRONMENT === 'development' ? ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8787'] : []),
    ];

    const isAllowed = allowedOrigins.some(o => {
      if (o.endsWith('*')) return origin.startsWith(o.slice(0, -1));
      return origin === o;
    });

    if (isAllowed) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
    }

    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Trace-ID');
    c.header('Access-Control-Expose-Headers', 'X-Trace-ID, API-Version');

    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: c.res.headers });
    }

    await next();
  };
}
