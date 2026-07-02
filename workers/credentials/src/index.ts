// G-C01: Credentials worker — encrypted per-Space credential storage.
//
// Credential hierarchy (CLAUDE.md open follow-up, closed here): a credential is resolved for an
// ACTING USER in three tiers, most-specific-wins EXCEPT a privileged override always wins:
//   1. space-scope row with is_override=1  — privileged (owner/admin) override, always wins
//   2. user-scope row for the acting user  — personal credential (the per-user default)
//   3. space-scope row with is_override=0  — shared space-wide fallback
// See resolveCredential() below and infra/migrations/0040_space_credentials.sql.
import { badRequest, errorResponse, forbidden, notFound, requestId, requireInternalHmac } from "@naelao/http";
import { Hono } from "hono";

// ── Env ───────────────────────────────────────────────────────────────────────

export interface CredentialsEnv {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
  CREDENTIAL_ENCRYPTION_KEY: string;
  PLATFORM_DB: D1Database;
  ANALYTICS: AnalyticsEngineDataset;
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

// G-AH07: Per-space key hierarchy. Root key is CREDENTIAL_ENCRYPTION_KEY.
// Per-space key is derived via HKDF(root_key, "naelao-cred-v1:<spaceId>").
// This means a single-key compromise only yields the root; space keys are non-extractable.

function parseKeyEnv(keyEnv: string): { version: string; hex: string } {
  const colonIdx = keyEnv.indexOf(":");
  if (colonIdx > 0 && keyEnv[0] === "v") {
    return { version: keyEnv.slice(0, colonIdx), hex: keyEnv.slice(colonIdx + 1) };
  }
  // Legacy: no version prefix — treat as v1
  return { version: "v1", hex: keyEnv };
}

// G-AH07: Derive a per-space AES-256-GCM key from the root key using HKDF-SHA256.
// The info string binds the derivation to the specific space — compromise of one
// space's derived key cannot be used to decrypt another space's credentials.
async function deriveSpaceKey(rootKeyHex: string, spaceId: string): Promise<CryptoKey> {
  const rootBytes = hexToBytes(rootKeyHex);
  const rootKey = await crypto.subtle.importKey("raw", rootBytes, { name: "HKDF" }, false, ["deriveBits"]);
  const info = new TextEncoder().encode(`naelao-cred-v1:${spaceId}`);
  const salt = new Uint8Array(32); // zero salt (info provides domain separation)
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    rootKey,
    256
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(
  plaintext: string,
  rootKeyEnv: string,
  spaceId: string
): Promise<{ ciphertext: string; iv: string; key_version: string }> {
  const { version, hex } = parseKeyEnv(rootKeyEnv);
  // G-AH07: Use space-specific derived key, not the root key directly
  const spaceKey = await deriveSpaceKey(hex, spaceId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, spaceKey, encoded);
  return { ciphertext: bytesToHex(new Uint8Array(encrypted)), iv: bytesToHex(iv), key_version: version };
}

async function decrypt(ciphertext: string, iv: string, rootKeyHex: string, spaceId: string): Promise<string> {
  // G-AH07: Derive the same per-space key for decryption
  const spaceKey = await deriveSpaceKey(rootKeyHex, spaceId);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(iv) },
    spaceKey,
    hexToBytes(ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}

/** Resolve the root key hex matching a stored row's key_version (handles rotation). */
function resolveRootKeyHex(
  env: CredentialsEnv,
  rowVersion: string | null
): string {
  const { version: currentVersion, hex: currentHex } = parseKeyEnv(env.CREDENTIAL_ENCRYPTION_KEY);
  const effectiveRowVersion = rowVersion ?? "v1";
  if (effectiveRowVersion === currentVersion) return currentHex;
  const prevKey = (env as CredentialsEnv & { CREDENTIAL_ENCRYPTION_KEY_PREV?: string }).CREDENTIAL_ENCRYPTION_KEY_PREV;
  if (prevKey) {
    const { version: prevVersion, hex: prevHex } = parseKeyEnv(prevKey);
    if (effectiveRowVersion === prevVersion) return prevHex;
  }
  return currentHex;
}

// ── G-F06: Short-lived per-request HMAC token for internal credential access ──
// Token format: "t=<unix-seconds>,aid=<agentId>,v1=<hmac-hex>"
// HMAC payload:  "<spaceId>:<agentId>:<timestamp>"
// Token expires after 60 seconds.

export async function generateCredentialToken(
  platformSecret: string,
  spaceId: string,
  agentId: string
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signingInput = `${spaceId}:${agentId}:${timestamp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},aid=${agentId},v1=${hexSig}`;
}

async function verifyCredentialToken(
  token: string,
  platformSecret: string,
  expectedSpaceId: string
): Promise<{ ok: boolean; reason?: string }> {
  const TOKEN_MAX_AGE_SECONDS = 60;
  const parts: Record<string, string> = {};
  for (const segment of token.split(",")) {
    const eq = segment.indexOf("=");
    if (eq > 0) parts[segment.slice(0, eq)] = segment.slice(eq + 1);
  }
  const timestamp = parseInt(parts["t"] ?? "0", 10);
  const agentId = parts["aid"] ?? "";
  const receivedHex = parts["v1"] ?? "";

  if (!agentId || !receivedHex) return { ok: false, reason: "Malformed credential token" };

  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (age < 0 || age > TOKEN_MAX_AGE_SECONDS) {
    return { ok: false, reason: `Credential token expired (age=${age}s)` };
  }

  const signingInput = `${expectedSpaceId}:${agentId}:${timestamp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(platformSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const expectedSigBytes = new Uint8Array(
    (receivedHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    expectedSigBytes,
    new TextEncoder().encode(signingInput)
  );
  if (!valid) return { ok: false, reason: "Invalid credential token signature" };
  return { ok: true };
}

// ── Validation ────────────────────────────────────────────────────────────────

const CREDENTIAL_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const PRIVILEGED_ROLES = new Set(["owner", "admin"]);

function validateCredentialName(name: string): void {
  if (!CREDENTIAL_NAME_RE.test(name)) {
    throw badRequest(
      "Credential name must be 1–64 characters: alphanumeric and underscore only"
    );
  }
}

function isPrivileged(role: string): boolean {
  return PRIVILEGED_ROLES.has(role);
}

// ── Credential hierarchy: row shape + resolution ─────────────────────────────

interface CredentialRow {
  id: string;
  space_id: string;
  tenant_id: string;
  name: string;
  scope: "user" | "space";
  user_id: string | null;
  is_override: number;
  encrypted_value: string;
  iv: string;
  key_version: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve the effective credential row for (spaceId, name, actingUserId) per the hierarchy:
 *   1. space-scope row with is_override=1  (privileged override — always wins)
 *   2. user-scope row for actingUserId      (personal, default)
 *   3. space-scope row with is_override=0   (shared fallback)
 * actingUserId may be omitted (e.g. an agent acting on behalf of the space as a whole, not a
 * specific member) — resolution then skips tier 2 and only considers the space-scope row.
 */
async function resolveCredential(
  db: D1Database,
  spaceId: string,
  tenantId: string,
  name: string,
  actingUserId: string | null
): Promise<CredentialRow | null> {
  const spaceRow = await db.prepare(
    `SELECT * FROM space_credentials WHERE space_id = ? AND tenant_id = ? AND name = ? AND scope = 'space' LIMIT 1`
  ).bind(spaceId, tenantId, name).first<CredentialRow>();

  if (spaceRow && spaceRow.is_override) return spaceRow;

  if (actingUserId) {
    const userRow = await db.prepare(
      `SELECT * FROM space_credentials WHERE space_id = ? AND tenant_id = ? AND name = ? AND scope = 'user' AND user_id = ? LIMIT 1`
    ).bind(spaceId, tenantId, name, actingUserId).first<CredentialRow>();
    if (userRow) return userRow;
  }

  return spaceRow ?? null;
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: CredentialsEnv }>();

app.use("*", requestId);
app.use("*", async (c, next) => {
  validateEnv(c.env);
  await next();
});

// B1/B3 fix: the three public CRUD routes only ever trust x-naelao-tenant-id/-user-id/-role
// as-is — with workers_dev disabled the router is the only path in, but this is the
// defense-in-depth backstop (a misconfiguration or a future direct binding must not be able
// to forge a tenant/role). The internal plaintext-resolution route below has its own,
// independent HMAC scheme (generateCredentialToken/verifyCredentialToken, scoped to a single
// agentId+spaceId) and is deliberately NOT covered by this — it's not proxied by the router.
app.use("/spaces/:spaceId/credentials", requireInternalHmac((c) => (c as unknown as { env: CredentialsEnv }).env.PLATFORM_SECRET));
app.use("/spaces/:spaceId/credentials/:credId", requireInternalHmac((c) => (c as unknown as { env: CredentialsEnv }).env.PLATFORM_SECRET));

// POST /v1/spaces/:spaceId/credentials — create a credential.
// Body: { name, value, description?, scope?: 'user'|'space' (default 'user'), is_override?: boolean }
// - scope='user' (default): a member's own personal credential. Always allowed for the caller,
//   always owned by the caller (a user can never create another user's credential).
// - scope='space': the shared space-wide credential. Requires owner/admin.
// - is_override=true: only valid with scope='space', requires owner/admin — forces this value
//   ahead of any member's personal credential of the same name.
app.post("/spaces/:spaceId/credentials", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "viewer";
  const spaceId = c.req.param("spaceId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (!userId) throw badRequest("x-naelao-user-id header is required");

  let body: {
    name: string;
    value: string;
    description?: string;
    scope?: "user" | "space";
    is_override?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }

  if (!body.name) throw badRequest("name is required");
  if (!body.value) throw badRequest("value is required");
  validateCredentialName(body.name);

  const scope = body.scope ?? "user";
  if (scope !== "user" && scope !== "space") {
    throw badRequest("scope must be 'user' or 'space'");
  }
  const isOverride = Boolean(body.is_override);
  if (isOverride && scope !== "space") {
    throw badRequest("is_override is only valid with scope='space'");
  }
  if ((scope === "space" || isOverride) && !isPrivileged(role)) {
    throw forbidden("Only owner/admin may set a space-shared credential or override");
  }

  // G-AH07: Space-derived key; each space's credentials use a distinct HKDF-derived key
  const { ciphertext, iv, key_version } = await encrypt(body.value, c.env.CREDENTIAL_ENCRYPTION_KEY, spaceId);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ownerUserId = scope === "user" ? userId : null;

  // Upsert on the unique (space,name,scope[,user]) index so re-saving the same name/scope
  // rotates the value in place rather than erroring or leaving orphaned rows.
  const conflictTarget = scope === "user" ? "(space_id, name, user_id)" : "(space_id, name)";
  await c.env.PLATFORM_DB.prepare(
    `INSERT INTO space_credentials
       (id, space_id, tenant_id, name, scope, user_id, is_override, encrypted_value, iv, key_version, description, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT ${conflictTarget} WHERE scope = '${scope}' DO UPDATE SET
       is_override = excluded.is_override,
       encrypted_value = excluded.encrypted_value,
       iv = excluded.iv,
       key_version = excluded.key_version,
       description = excluded.description,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      spaceId,
      tenantId,
      body.name,
      scope,
      ownerUserId,
      isOverride ? 1 : 0,
      ciphertext,
      iv,
      key_version,
      body.description ?? null,
      userId,
      now,
      now
    )
    .run();

  return c.json(
    {
      id,
      name: body.name,
      scope,
      is_override: isOverride,
      description: body.description ?? null,
      created_at: now,
    },
    201
  );
});

// GET /v1/spaces/:spaceId/credentials — list credentials (metadata only, never values).
// A non-privileged caller sees: their own user-scoped credentials + all space-scoped ones
// (so they can see what's shared/overridden, without seeing teammates' personal credentials).
// A privileged caller (owner/admin) sees everything, for management/audit visibility.
app.get("/spaces/:spaceId/credentials", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "viewer";
  const spaceId = c.req.param("spaceId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");

  const query = isPrivileged(role)
    ? c.env.PLATFORM_DB.prepare(
        `SELECT id, name, scope, user_id, is_override, description, created_at
         FROM space_credentials
         WHERE space_id = ? AND tenant_id = ?
         ORDER BY created_at DESC`
      ).bind(spaceId, tenantId)
    : c.env.PLATFORM_DB.prepare(
        `SELECT id, name, scope, user_id, is_override, description, created_at
         FROM space_credentials
         WHERE space_id = ? AND tenant_id = ? AND (scope = 'space' OR user_id = ?)
         ORDER BY created_at DESC`
      ).bind(spaceId, tenantId, userId);

  const results = await query.all<{
    id: string;
    name: string;
    scope: "user" | "space";
    user_id: string | null;
    is_override: number;
    description: string | null;
    created_at: string;
  }>();

  return c.json({
    credentials: results.results.map((r) => ({ ...r, is_override: Boolean(r.is_override) })),
  });
});

// DELETE /v1/spaces/:spaceId/credentials/:credId — delete a credential.
// A user may always delete their own user-scoped credential. Deleting a space-scoped
// credential (shared or override) requires owner/admin.
app.delete("/spaces/:spaceId/credentials/:credId", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const userId = c.req.header("x-naelao-user-id") ?? "";
  const role = c.req.header("x-naelao-role") ?? "viewer";
  const spaceId = c.req.param("spaceId");
  const credId = c.req.param("credId");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");

  const row = await c.env.PLATFORM_DB.prepare(
    `SELECT scope, user_id FROM space_credentials WHERE id = ? AND space_id = ? AND tenant_id = ?`
  ).bind(credId, spaceId, tenantId).first<{ scope: "user" | "space"; user_id: string | null }>();
  if (!row) throw notFound("Credential");

  const isOwnCredential = row.scope === "user" && row.user_id === userId;
  if (!isOwnCredential && !isPrivileged(role)) {
    throw forbidden("Only the owning member or an owner/admin may delete this credential");
  }

  const result = await c.env.PLATFORM_DB.prepare(
    `DELETE FROM space_credentials WHERE id = ? AND space_id = ? AND tenant_id = ?`
  )
    .bind(credId, spaceId, tenantId)
    .run();

  if (result.meta.changes === 0) {
    throw notFound("Credential");
  }

  return c.json({ deleted: true });
});

// POST /v1/internal/spaces/:spaceId/credentials/:name/plaintext
// Internal endpoint — returns decrypted value for agent tool dispatch, resolved through the
// credential hierarchy for an optional acting user (body.on_behalf_of_user_id). Callers that
// don't know/care about a specific member (e.g. mcp-hub resolving a connector's own secret)
// omit it and get the effective space-level credential (override, else shared).
// G-F06: Requires short-lived HMAC credential token (x-naelao-credential-token)
//        embedding {spaceId}:{agentId}:{timestamp}, expires 60s.
app.post("/v1/internal/spaces/:spaceId/credentials/:name/plaintext", async (c) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  const credentialToken = c.req.header("x-naelao-credential-token") ?? "";
  const spaceId = c.req.param("spaceId");
  const credName = c.req.param("name");

  if (!tenantId) throw badRequest("x-naelao-tenant-id header is required");
  if (!credentialToken) throw forbidden("x-naelao-credential-token header is required");

  // G-F06: Verify short-lived HMAC token — prevents cross-space exfiltration
  const tokenCheck = await verifyCredentialToken(credentialToken, c.env.PLATFORM_SECRET, spaceId);
  if (!tokenCheck.ok) {
    throw forbidden(tokenCheck.reason ?? "Invalid credential token");
  }

  let onBehalfOfUserId: string | null = null;
  try {
    const body = await c.req.json<{ on_behalf_of_user_id?: string }>();
    onBehalfOfUserId = body.on_behalf_of_user_id ?? null;
  } catch {
    // Empty/absent body is fine — resolves at the space level.
  }

  const row = await resolveCredential(c.env.PLATFORM_DB, spaceId, tenantId, credName, onBehalfOfUserId);
  if (!row) {
    throw notFound("Credential");
  }

  // G-AH07/G-D05: Resolve the root key matching this credential's key_version for decryption.
  const rootHex = resolveRootKeyHex(c.env, row.key_version);

  // G-AH07: Re-derive the per-space key from the resolved root key hex and spaceId
  const value = await decrypt(row.encrypted_value, row.iv, rootHex, spaceId);

  // G-D06: Immutable audit entry — credential_access event in Analytics Engine
  try {
    const tokenParts: Record<string, string> = {};
    for (const seg of credentialToken.split(",")) {
      const eq = seg.indexOf("=");
      if (eq > 0) tokenParts[seg.slice(0, eq)] = seg.slice(eq + 1);
    }
    c.env.ANALYTICS.writeDataPoint({
      blobs: [
        "credential_access",          // blob1: event_name
        row.name,                     // blob2: credential_name (not the value)
        spaceId,                      // blob3: space_id
        tokenParts["aid"] ?? "",      // blob4: agent_id
        tenantId,                     // blob5: tenant_id
        row.scope,                    // blob6: resolved scope (user | space)
      ],
      doubles: [Date.now()],          // double1: access_timestamp_ms
      indexes: [spaceId],
    });
  } catch {
    // Best-effort — audit failures must not block the credential read
  }

  return c.json({ name: row.name, value, scope: row.scope, is_override: Boolean(row.is_override) });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => errorResponse(err, c.get("requestId") ?? "unknown"));

// ── Export ────────────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,
} satisfies ExportedHandler<CredentialsEnv>;
