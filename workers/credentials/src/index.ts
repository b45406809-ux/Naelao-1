// G-C01: Credentials worker — encrypted per-Space credential storage
import { badRequest, errorResponse, forbidden, notFound, requestId } from "@naelao/http";
import { Hono } from "hono";

// ── Env ───────────────────────────────────────────────────────────────────────

export interface CredentialsEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  PLATFORM_DB: D1Database;
}

function validateEnv(env: CredentialsEnv): void {
  if (!env.PLATFORM_SECRET) throw new Error("Missing required secret: PLATFORM_SECRET");
  if (!env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error("Missing required secret: CREDENTIAL_ENCRYPTION_KEY");
  }
}

// ── Hex encode/decode helpers ─────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string length");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (isNaN(byte)) throw new Error(`Invalid hex character at position ${i * 2}`);
    bytes[i] = byte;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── AES-256-GCM encryption helpers ───────────────────────────────────────────
// G-D05: Credentials store a key_version alongside each encrypted record.
// On key rotation: new encryptions use the new key version; old records can be
// re-encrypted by reading them with the old key and re-writing with the new key.
// The CREDENTIAL_ENCRYPTION_KEY env var encodes "v<N>:<hex-key>", e.g. "v2:<32bytes-hex>".
// Multiple previous keys can be provided as CREDENTIAL_ENCRYPTION_KEY_PREV for re-encryption.

function parseKeyEnv(keyEnv: string): { version: string; hex: string } {
  const colonIdx = keyEnv.indexOf(":");
  if (colonIdx > 0 && keyEnv[0] === "v") {
    return { version: keyEnv.slice(0, colonIdx), hex: keyEnv.slice(colonIdx + 1) };
  }
  // Legacy: no version prefix — treat as v1
  return { version: "v1", hex: keyEnv };
}

async function encrypt(
  plaintext: string,
  key: string
): Promise<{ ciphertext: string; iv: string; key_version: string }> {
  const { version, hex } = parseKeyEnv(key);
  const keyBytes = await crypto.subtle.importKey(
    "raw",
    hexToBytes(hex),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyBytes, encoded);
  return { ciphertext: bytesToHex(new Uint8Array(encrypted)), iv: bytesToHex(iv), key_version: version };
}

async function decrypt(ciphertext: string, iv: string, key: string): Promise<string> {
  const { hex } = parseKeyEnv(key);
  const keyBytes = await crypto.subtle.importKey(
    "raw",
    hexToBytes(hex),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(iv) },
    keyBytes,
    hexToBytes(ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}

// ── Validation ────────────────────────────────────────────────────────────────

const CREDENTIAL_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

function validateCredentialName(name: string): void {
  if (!CREDENTIAL_NAME_RE.test(name)) {
    throw badRequest(
      "Credential name must be 1–64 characters: alphanumeric and underscore only"
    );
  }
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: CredentialsEnv }>();

app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

// POST /v1/spaces/:spaceId/credentials — create a credential
app.post("/v1/spaces/:spaceId/credentials", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");

  let body: { name: string; value: string; description?: string };
  try {
    body = await c.req.json<{ name: string; value: string; description?: string }>();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.name) throw badRequest("name is required");
  if (!body.value) throw badRequest("value is required");

  validateCredentialName(body.name);

  const { ciphertext, iv, key_version } = await encrypt(body.value, c.env.CREDENTIAL_ENCRYPTION_KEY);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO space_credentials
       (id, space_id, tenant_id, name, encrypted_value, iv, key_version, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      spaceId,
      tenantId,
      body.name,
      ciphertext,
      iv,
      key_version,
      body.description ?? null,
      now,
      now
    )
    .run();

  return c.json(
    {
      id,
      name: body.name,
      description: body.description ?? null,
      created_at: now,
    },
    201
  );
});

// GET /v1/spaces/:spaceId/credentials — list credentials (names only, no values)
app.get("/v1/spaces/:spaceId/credentials", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");

  const results = await c.env.PLATFORM_DB.prepare(
    `SELECT id, name, description, created_at
     FROM space_credentials
     WHERE space_id = ? AND tenant_id = ?
     ORDER BY created_at DESC`
  )
    .bind(spaceId, tenantId)
    .all<{
      id: string;
      name: string;
      description: string | null;
      created_at: string;
    }>();

  return c.json({ credentials: results.results });
});

// DELETE /v1/spaces/:spaceId/credentials/:credId — delete a credential
app.delete("/v1/spaces/:spaceId/credentials/:credId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const spaceId = c.req.param("spaceId");
  const credId = c.req.param("credId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");

  const result = await c.env.PLATFORM_DB.prepare(
    `DELETE FROM space_credentials
     WHERE id = ? AND space_id = ? AND tenant_id = ?`
  )
    .bind(credId, spaceId, tenantId)
    .run();

  if (result.meta.changes === 0) {
    throw notFound("Credential");
  }

  return c.json({ deleted: true });
});

// POST /v1/internal/spaces/:spaceId/credentials/:name/plaintext
// Internal endpoint — returns decrypted value for agent tool dispatch
app.post("/v1/internal/spaces/:spaceId/credentials/:name/plaintext", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const platformSecret = c.req.header("x-naelao-platform-secret") ?? "";
  const spaceId = c.req.param("spaceId");
  const credName = c.req.param("name");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (platformSecret !== c.env.PLATFORM_SECRET) {
    throw forbidden("Invalid platform secret");
  }

  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT name, encrypted_value, iv, key_version
     FROM space_credentials
     WHERE name = ? AND space_id = ? AND tenant_id = ?
     LIMIT 1`
  )
    .bind(credName, spaceId, tenantId)
    .first<{
      name: string;
      encrypted_value: string;
      iv: string;
      key_version: string | null;
    }>();

  if (!row) {
    throw notFound("Credential");
  }

  // G-D05: Use the key matching this credential's key_version.
  // If key_version matches the current key's version, use it directly.
  // Otherwise try the previous key env var (CREDENTIAL_ENCRYPTION_KEY_PREV) for rotation.
  const currentKey = c.env.CREDENTIAL_ENCRYPTION_KEY;
  const { version: currentVersion } = parseKeyEnv(currentKey);
  const rowVersion = row.key_version ?? "v1";

  let decryptKey = currentKey;
  if (rowVersion !== currentVersion) {
    const prevKey = (c.env as typeof c.env & { CREDENTIAL_ENCRYPTION_KEY_PREV?: string }).CREDENTIAL_ENCRYPTION_KEY_PREV;
    if (prevKey) {
      const { version: prevVersion } = parseKeyEnv(prevKey);
      if (rowVersion === prevVersion) {
        decryptKey = prevKey;
      }
    }
  }

  const value = await decrypt(row.encrypted_value, row.iv, decryptKey);

  return c.json({ name: row.name, value });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── Export ────────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<CredentialsEnv>;
