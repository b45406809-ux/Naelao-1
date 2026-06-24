interface Env {
  NAELAO_PORTAL_ROUTES: KVNamespace;
  NAELAO_SPACES: Fetcher;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
  NAELAO_ANALYTICS: AnalyticsEngineDataset;
}

export const RESERVED_SLUGS = new Set([
  'naelao', 'admin', 'api', 'support', 'billing', 'app', 'www', 'mail',
  'smtp', 'ftp', 'ssh', 'dashboard', 'login', 'auth', 'status', 'health',
  'docs', 'help', 'blog', 'about', 'legal', 'privacy', 'terms', 'careers',
  'jobs', 'team',
]);

const routeCache = new Map<string, { spaceId: string; expiresAt: number }>();

function brandedNotFound(): Response {
  return new Response(
    '<!DOCTYPE html><html><head><title>Not Found — Naelao</title></head><body><h1>404 — Space Not Found</h1></body></html>',
    { status: 404, headers: { 'Content-Type': 'text/html' } }
  );
}

async function lookupSpaceId(hostname: string, env: Env): Promise<string | null> {
  const cached = routeCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.spaceId;

  const url = new URL('https://' + hostname);
  const hostParts = url.hostname.split('.');

  let spaceId: string | null = null;

  if (url.hostname.endsWith('.naelao.app')) {
    const slug = hostParts[0] ?? '';
    if (RESERVED_SLUGS.has(slug)) return null;
    spaceId = await env.NAELAO_PORTAL_ROUTES.get('slug:' + slug);
  } else {
    spaceId = await env.NAELAO_PORTAL_ROUTES.get('host:' + url.hostname);
  }

  if (spaceId) {
    routeCache.set(hostname, { spaceId, expiresAt: Date.now() + 60_000 });
  }

  return spaceId;
}

async function checkRateLimit(hostname: string, env: Env): Promise<boolean> {
  const key = 'portal-rl:' + hostname;
  const current = parseInt((await env.NAELAO_CIRCUIT_KV.get(key)) ?? '0');
  if (current >= 1000) return false;
  await env.NAELAO_CIRCUIT_KV.put(key, String(current + 1), { expirationTtl: 60 });
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;

    if (!await checkRateLimit(hostname, env)) {
      return new Response('Rate limit exceeded', { status: 429 });
    }

    const spaceId = await lookupSpaceId(hostname, env);
    if (!spaceId) return brandedNotFound();

    const forwardRequest = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body,
    });
    (forwardRequest.headers as Headers).set('X-Portal-Space-ID', spaceId);

    return env.NAELAO_SPACES.fetch(forwardRequest);
  },
};
