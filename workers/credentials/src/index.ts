/**
 * AVOS Credentials Worker
 * Implements the 3-Tier Hierarchical Credential Resolution Engine.
 */

import { Gatekeeper, SecurityContext, ConnectorScope } from '../../../packages/security/src/gatekeeper';

export interface Env {
  DB: D1Database;
  ENCRYPTION_SECRET: string;
}

export interface ResolveCredentialParams {
  spaceId: string;
  name: string;
  actingUserId?: string;
  projectId?: string;
  threadKind?: 'public_channel' | 'project_room' | 'direct_message' | 'private_scratchpad';
}

export interface CredentialRecord {
  id: string;
  space_id: string;
  name: string;
  scope: ConnectorScope;
  project_id: string | null;
  user_id: string | null;
  value: string;
  created_at: number;
  updated_at: number;
}

/**
 * Decrypts symmetric secret string.
 */
async function decryptValue(encryptedText: string, secret: string): Promise<string> {
  // Check for plain format (e.g. dev/simulated env) or base64 AES-GCM
  if (!encryptedText.includes(':')) {
    try {
      return atob(encryptedText);
    } catch {
      return encryptedText;
    }
  }

  try {
    const [ivHex, cipherHex] = encryptedText.split(':');
    const iv = new Uint8Array(ivHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    const cipherData = new Uint8Array(cipherHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret.padEnd(32, '0').slice(0, 32)),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      keyMaterial,
      cipherData
    );

    return new TextDecoder().decode(decrypted);
  } catch (err) {
    // Fallback if raw text
    return encryptedText;
  }
}

/**
 * Encrypts symmetric secret string.
 */
async function encryptValue(plainText: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret.padEnd(32, '0').slice(0, 32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    keyMaterial,
    enc.encode(plainText)
  );

  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
  const cipherHex = Array.from(new Uint8Array(cipherBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${ivHex}:${cipherHex}`;
}

/**
 * Hierarchical Resolution Logic
 * 1. Tier 3: User-Personal (if actingUserId provided and thread allows)
 * 2. Tier 2: Project-Bound (if projectId provided)
 * 3. Tier 1: Space-Shared (fallback)
 */
export async function resolveCredential(
  db: D1Database,
  params: ResolveCredentialParams,
  encryptionSecret: string
): Promise<{ value: string; scope: ConnectorScope; credentialId: string } | null> {
  const { spaceId, name, actingUserId, projectId, threadKind = 'private_scratchpad' } = params;
  const securityContext: SecurityContext = {
    spaceId,
    projectId,
    actingUserId,
    threadKind
  };

  // 1. Check Tier 3: User-Personal (Highest Priority)
  if (actingUserId && (threadKind === 'private_scratchpad' || threadKind === 'direct_message')) {
    const personal = await db
      .prepare(
        "SELECT * FROM space_credentials WHERE space_id = ? AND name = ? AND user_id = ? AND scope = 'user' LIMIT 1"
      )
      .bind(spaceId, name, actingUserId)
      .first<CredentialRecord>();

    if (personal) {
      Gatekeeper.assertCredentialAccess(securityContext, {
        spaceId: personal.space_id,
        scope: personal.scope,
        projectId: personal.project_id,
        userId: personal.user_id,
      });

      const decrypted = await decryptValue(personal.value, encryptionSecret);
      return { value: decrypted, scope: 'user', credentialId: personal.id };
    }
  }

  // 2. Check Tier 2: Project-Bound
  if (projectId) {
    const projectBound = await db
      .prepare(
        "SELECT * FROM space_credentials WHERE space_id = ? AND name = ? AND project_id = ? AND scope = 'project' LIMIT 1"
      )
      .bind(spaceId, name, projectId)
      .first<CredentialRecord>();

    if (projectBound) {
      Gatekeeper.assertCredentialAccess(securityContext, {
        spaceId: projectBound.space_id,
        scope: projectBound.scope,
        projectId: projectBound.project_id,
        userId: projectBound.user_id,
      });

      const decrypted = await decryptValue(projectBound.value, encryptionSecret);
      return { value: decrypted, scope: 'project', credentialId: projectBound.id };
    }
  }

  // 3. Check Tier 1: Space-Shared (Fallback)
  const shared = await db
    .prepare(
      "SELECT * FROM space_credentials WHERE space_id = ? AND name = ? AND scope = 'space' LIMIT 1"
    )
    .bind(spaceId, name)
    .first<CredentialRecord>();

  if (shared) {
    Gatekeeper.assertCredentialAccess(securityContext, {
      spaceId: shared.space_id,
      scope: shared.scope,
      projectId: shared.project_id,
      userId: shared.user_id,
    });

    const decrypted = await decryptValue(shared.value, encryptionSecret);
    return { value: decrypted, scope: 'space', credentialId: shared.id };
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secret = env.ENCRYPTION_SECRET || 'avos-default-credential-secret-key-32b';

    // Route: POST /resolve
    if (url.pathname === '/resolve' && request.method === 'POST') {
      try {
        const body = (await request.json()) as ResolveCredentialParams;
        if (!body.spaceId || !body.name) {
          return new Response(JSON.stringify({ error: 'Missing required parameters: spaceId, name' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const result = await resolveCredential(env.DB, body, secret);
        if (!result) {
          return new Response(JSON.stringify({ error: 'Credential not found or unauthorized' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, ...result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || 'Internal Server Error' }), {
          status: err.message?.includes('Access Denied') ? 403 : 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Route: POST /store
    if (url.pathname === '/store' && request.method === 'POST') {
      try {
        const body = (await request.json()) as {
          spaceId: string;
          name: string;
          value: string;
          scope: ConnectorScope;
          projectId?: string;
          userId?: string;
        };

        if (!body.spaceId || !body.name || !body.value || !body.scope) {
          return new Response(JSON.stringify({ error: 'Missing required store payload fields' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const id = crypto.randomUUID();
        const encrypted = await encryptValue(body.value, secret);
        const now = Date.now();

        await env.DB.prepare(
          `INSERT INTO space_credentials (id, space_id, name, scope, project_id, user_id, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(space_id, name, scope, COALESCE(project_id, ''), COALESCE(user_id, ''))
           DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
          .bind(
            id,
            body.spaceId,
            body.name,
            body.scope,
            body.projectId || null,
            body.userId || null,
            encrypted,
            now,
            now
          )
          .run();

        return new Response(JSON.stringify({ success: true, id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || 'Store Error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};
