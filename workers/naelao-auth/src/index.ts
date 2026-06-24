import { Hono } from 'hono';
import { signJWT, verifyJWT, type JWTPayload } from './jwt';
import { authMiddleware } from './middleware';

interface Env {
  NAELAO_JWT_SECRET: string;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

async function hashPassword(password: string, salt?: Uint8Array): Promise<{ hash: string; salt: Uint8Array }> {
  const saltBytes = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const saltHex = [...saltBytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = [...new Uint8Array(derived)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { hash: saltHex + ':' + hashHex, salt: saltBytes };
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const colonIdx = storedHash.indexOf(':');
  if (colonIdx === -1) return false;
  const saltHex = storedHash.slice(0, colonIdx);
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  const { hash } = await hashPassword(password, saltBytes);
  if (hash.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= (hash.charCodeAt(i) ?? 0) ^ (storedHash.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

app.post('/v1/auth/register', async (c) => {
  const { email, password, name } = await c.req.json<{ email: string; password: string; name: string }>();

  if (!email || !password || !name) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'email, password and name required' } }, 400);
  }

  const existing = await c.env.NAELAO_CONFIG_KV.get(`user:hash:${email}`);
  if (existing) {
    return c.json({ error: { code: 'EMAIL_EXISTS', message: 'Email already registered' } }, 409);
  }

  const { hash } = await hashPassword(password);
  const builderId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  await c.env.NAELAO_CONFIG_KV.put(`user:hash:${email}`, JSON.stringify({ hash, userId, builderId, name }));
  await c.env.NAELAO_CONFIG_KV.put(`user:id:${userId}`, JSON.stringify({ email, builderId, name }));

  const token = await signJWT(
    { sub: userId, spaceId: '', rootSpaceId: '', role: 'owner', builderId },
    c.env.NAELAO_JWT_SECRET,
    3600
  );

  return c.json({ data: { token, builderId } });
});

app.post('/v1/auth/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const rlKey = `rl:login:${ip}`;

  const rlRaw = await c.env.NAELAO_CONFIG_KV.get(rlKey);
  const attempts = rlRaw ? parseInt(rlRaw, 10) : 0;
  if (attempts >= 10) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many login attempts' } }, 429);
  }

  const { email, password } = await c.req.json<{ email: string; password: string }>();

  const userRaw = await c.env.NAELAO_CONFIG_KV.get(`user:hash:${email}`);
  if (!userRaw) {
    await c.env.NAELAO_CONFIG_KV.put(rlKey, String(attempts + 1), { expirationTtl: 900 });
    return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401);
  }

  const user = JSON.parse(userRaw) as { hash: string; userId: string; builderId: string; name: string };
  const valid = await verifyPassword(password, user.hash);
  if (!valid) {
    await c.env.NAELAO_CONFIG_KV.put(rlKey, String(attempts + 1), { expirationTtl: 900 });
    return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }, 401);
  }

  const token = await signJWT(
    { sub: user.userId, spaceId: '', rootSpaceId: '', role: 'owner', builderId: user.builderId },
    c.env.NAELAO_JWT_SECRET,
    3600
  );

  const refreshToken = crypto.randomUUID();
  await c.env.NAELAO_CONFIG_KV.put(
    `refresh:${refreshToken}`,
    JSON.stringify({ userId: user.userId, builderId: user.builderId }),
    { expirationTtl: 604800 }
  );

  return c.json({ data: { token, refreshToken } });
});

app.post('/v1/auth/refresh', async (c) => {
  const { refreshToken } = await c.req.json<{ refreshToken: string }>();
  const stored = await c.env.NAELAO_CONFIG_KV.get(`refresh:${refreshToken}`);
  if (!stored) {
    return c.json({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token' } }, 401);
  }

  const { userId, builderId } = JSON.parse(stored) as { userId: string; builderId: string };
  const token = await signJWT(
    { sub: userId, spaceId: '', rootSpaceId: '', role: 'owner', builderId },
    c.env.NAELAO_JWT_SECRET,
    3600
  );

  return c.json({ data: { token } });
});

app.post('/v1/auth/logout', async (c) => {
  const { refreshToken } = await c.req.json<{ refreshToken: string }>();
  await c.env.NAELAO_CONFIG_KV.delete(`refresh:${refreshToken}`);
  return c.json({ data: { ok: true } });
});

app.get('/v1/auth/me', authMiddleware({ NAELAO_JWT_SECRET: '', NAELAO_CONFIG_KV: undefined as unknown as KVNamespace }), async (c) => {
  return c.json({ data: c.get('jwt') });
});

app.post('/v1/auth/space-token', async (c) => {
  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token required' } }, 401);
  }

  let payload: JWTPayload;
  try {
    payload = await verifyJWT(auth.slice(7), c.env.NAELAO_JWT_SECRET);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }

  const { spaceId } = await c.req.json<{ spaceId: string }>();
  const token = await signJWT(
    { sub: payload.sub, spaceId, rootSpaceId: payload.rootSpaceId, role: payload.role, builderId: payload.builderId },
    c.env.NAELAO_JWT_SECRET,
    3600
  );

  return c.json({ data: { token } });
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    return app.fetch(request, env, ctx);
  },
};
