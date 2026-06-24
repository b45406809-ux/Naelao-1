import { Hono } from 'hono';
import { verifyJWT } from '../../naelao-auth/src/jwt';
import {
  wrapHtmlArtifact,
  wrapReactArtifact,
  scanCodeForVulnerabilities,
  ARTIFACT_SECURITY_HEADERS,
  type ArtifactType,
} from './sandbox';

interface Env {
  NAELAO_ARTIFACTS: R2Bucket;
  NAELAO_ARTIFACT_KV: KVNamespace;
  NAELAO_DISPATCH_NS: DispatchNamespace;
  NAELAO_JWT_SECRET: string;
  NAELAO_CONFIG_KV: KVNamespace;
  NAELAO_CIRCUIT_KV: KVNamespace;
}

interface ArtifactMeta {
  type: ArtifactType;
  title?: string;
  spaceId: string;
  createdAt: string;
  size: number;
}

const EXT: Record<ArtifactType, string> = {
  html: 'html', react: 'jsx', json: 'json', markdown: 'md', csv: 'csv',
};

const CONTENT_TYPE: Record<ArtifactType, string> = {
  html: 'text/html; charset=utf-8',
  react: 'text/html; charset=utf-8',
  json: 'application/json',
  markdown: 'text/markdown',
  csv: 'text/csv',
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'";

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  if (c.req.method === 'GET' && c.req.path.startsWith('/v1/artifacts/')) {
    await next();
    return;
  }
  const token = (c.req.header('Authorization') ?? '').replace('Bearer ', '');
  if (!token) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } }, 401);
  try {
    const jwt = await verifyJWT(token, c.env.NAELAO_JWT_SECRET);
    c.set('jwt' as never, jwt);
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }
  await next();
});

app.post('/v1/artifacts', async (c) => {
  const jwt = c.get('jwt' as never) as { sub: string; spaceId: string };
  const { type, code, title, spaceId } = await c.req.json<{
    type: ArtifactType; code: string; title?: string; spaceId?: string;
  }>();

  const scan = scanCodeForVulnerabilities(code);
  if (!scan.safe) {
    return c.json({ error: { code: 'UNSAFE_CODE', message: 'Code contains unsafe patterns: ' + scan.reason } }, 422);
  }

  const sid = spaceId ?? jwt.spaceId;
  const artifactId = crypto.randomUUID();
  const ext = EXT[type] ?? 'txt';
  const r2Key = 'artifacts/' + sid + '/' + artifactId + '.' + ext;

  let content: string;
  if (type === 'html') {
    content = wrapHtmlArtifact(code, title);
  } else if (type === 'react') {
    const r2Url = 'https://artifacts.naelao.com/' + r2Key;
    await c.env.NAELAO_ARTIFACTS.put(r2Key + '.raw', code);
    content = wrapReactArtifact(r2Url + '.raw');
  } else {
    content = code;
  }

  await c.env.NAELAO_ARTIFACTS.put(r2Key, content);

  const meta: ArtifactMeta = {
    type, title, spaceId: sid,
    createdAt: new Date().toISOString(),
    size: content.length,
  };
  await c.env.NAELAO_ARTIFACT_KV.put('artifact:' + artifactId, JSON.stringify(meta));

  return c.json({ data: { artifactId, url: '/v1/artifacts/' + artifactId } });
});

app.get('/v1/artifacts/:artifactId', async (c) => {
  const artifactId = c.req.param('artifactId');
  const meta = await c.env.NAELAO_ARTIFACT_KV.get<ArtifactMeta>('artifact:' + artifactId, 'json');
  if (!meta) return c.json({ error: { code: 'NOT_FOUND', message: 'Artifact not found' } }, 404);

  const ext = EXT[meta.type] ?? 'txt';
  const r2Key = 'artifacts/' + meta.spaceId + '/' + artifactId + '.' + ext;
  const obj = await c.env.NAELAO_ARTIFACTS.get(r2Key);
  if (!obj) return c.json({ error: { code: 'NOT_FOUND', message: 'Artifact data not found' } }, 404);

  const headers = new Headers({
    'Content-Type': CONTENT_TYPE[meta.type] ?? 'text/plain',
    'Content-Security-Policy': CSP,
    ...ARTIFACT_SECURITY_HEADERS,
  });

  return new Response(await obj.text(), { headers });
});

app.delete('/v1/artifacts/:artifactId', async (c) => {
  const jwt = c.get('jwt' as never) as { sub: string; spaceId: string };
  const artifactId = c.req.param('artifactId');

  const meta = await c.env.NAELAO_ARTIFACT_KV.get<ArtifactMeta>('artifact:' + artifactId, 'json');
  if (!meta) return c.json({ error: { code: 'NOT_FOUND', message: 'Artifact not found' } }, 404);
  if (meta.spaceId !== jwt.spaceId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not the artifact owner' } }, 403);
  }

  const ext = EXT[meta.type] ?? 'txt';
  await c.env.NAELAO_ARTIFACTS.delete('artifacts/' + meta.spaceId + '/' + artifactId + '.' + ext);
  await c.env.NAELAO_ARTIFACT_KV.delete('artifact:' + artifactId);

  return c.json({ data: { deleted: true } });
});

export default { fetch: app.fetch };
