// Three-Tier Platform Model (spec "Three-Tier Platform Model" / "How Builders Use Naelao"),
// Phase 1 (docs/spec-appendix/A1-script-agents-and-space-assistants.md §A1.17). One per builder
// (== tenant in this codebase's model), addressed via getDOName("builder", tenantId, tenantId,
// PLATFORM_SECRET) — the same HMAC-named pattern SpaceDO uses, so a builder account DO can't be
// enumerated by guessing a raw tenantId.
//
// Deliberately thin: this DO indexes a builder's products and holds their scoped API keys. It
// does NOT reimplement usage aggregation, invoicing, or rate limiting — those already exist
// platform-wide (@naelao/entitlements + Analytics Engine; reseller_ledger / GET
// /reseller/statement; workers/router/src/RateLimitDO.ts) and the Builder Dashboard API (Phase
// 3) calls into them directly rather than through this DO. Adding parallel tables here for any
// of the three would be the exact split-brain this whole effort is trying to avoid.
//
// Naming note: workers/agents/src/do/ProductDO.ts already exists (a legacy Whop-niche singleton
// being retired, CLAUDE.md #4/#11) — this is a different class, do not conflate the two.

import { DurableObject } from "cloudflare:workers";

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string; // JSON array
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class BuilderAccountDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS products (
        product_space_id TEXT PRIMARY KEY,
        added_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        key_hash      TEXT NOT NULL,
        key_prefix    TEXT NOT NULL,
        scopes        TEXT NOT NULL DEFAULT '[]',
        last_used_at  TEXT,
        expires_at    TEXT,
        revoked_at    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // POST /products — index a product this builder owns (called once at launch).
    if (method === "POST" && url.pathname === "/products") {
      const body = await request.json<{ product_space_id: string }>();
      if (!body.product_space_id) {
        return Response.json({ error: "product_space_id is required" }, { status: 400 });
      }
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO products (product_space_id) VALUES (?)",
        body.product_space_id
      );
      return Response.json({ ok: true }, { status: 201 });
    }

    // GET /products — this builder's product index.
    if (method === "GET" && url.pathname === "/products") {
      const rows = this.ctx.storage.sql
        .exec("SELECT product_space_id, added_at FROM products ORDER BY added_at DESC")
        .toArray() as unknown as { product_space_id: string; added_at: string }[];
      return Response.json({ data: rows });
    }

    // POST /api-keys — mint a new scoped builder API key. Returns the raw key exactly once;
    // only its SHA-256 hash and a short prefix (for UI display) are ever persisted.
    if (method === "POST" && url.pathname === "/api-keys") {
      const body = await request.json<{ name: string; scopes: string[]; expires_in_days?: number }>();
      if (!body.name || !Array.isArray(body.scopes) || body.scopes.length === 0) {
        return Response.json({ error: "name and at least one scope are required" }, { status: 400 });
      }
      const id = crypto.randomUUID();
      const rawKey = `nbk_${crypto.randomUUID().replace(/-/g, "")}`;
      const keyHash = await sha256Hex(rawKey);
      const keyPrefix = rawKey.slice(0, 11); // "nbk_" + 7 chars
      const now = new Date();
      const expiresAt = body.expires_in_days
        ? new Date(now.getTime() + body.expires_in_days * 86_400_000).toISOString()
        : null;
      this.ctx.storage.sql.exec(
        `INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, body.name, keyHash, keyPrefix, JSON.stringify(body.scopes), expiresAt, now.toISOString()
      );
      return Response.json({
        id, key: rawKey, name: body.name, key_prefix: keyPrefix,
        scopes: body.scopes, last_used_at: null, expires_at: expiresAt, created_at: now.toISOString(),
      }, { status: 201 });
    }

    // GET /api-keys — list this builder's keys (never returns the raw key or its hash).
    if (method === "GET" && url.pathname === "/api-keys") {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, name, key_prefix, scopes, last_used_at, expires_at, created_at
           FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`
        )
        .toArray() as unknown as ApiKeyRow[];
      return Response.json({
        data: rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) as string[] })),
      });
    }

    // DELETE /api-keys/:id — revoke (soft delete; row kept for audit).
    const revokeMatch = url.pathname.match(/^\/api-keys\/([^/]+)$/);
    if (method === "DELETE" && revokeMatch?.[1]) {
      this.ctx.storage.sql.exec(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        new Date().toISOString(), revokeMatch[1]
      );
      return new Response(null, { status: 204 });
    }

    // POST /api-keys/verify — internal: validateProductScope middleware (Phase 3) resolves a
    // Bearer nbk_... key to its scopes here before any /builder/* route runs.
    if (method === "POST" && url.pathname === "/api-keys/verify") {
      const body = await request.json<{ key: string }>();
      if (!body.key) return Response.json({ valid: false }, { status: 400 });
      const keyHash = await sha256Hex(body.key);
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT id, scopes, expires_at FROM api_keys
           WHERE key_hash = ? AND revoked_at IS NULL`,
          keyHash
        )
        .toArray() as unknown as { id: string; scopes: string; expires_at: string | null }[];
      const row = rows[0];
      if (!row) return Response.json({ valid: false });
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return Response.json({ valid: false });
      }
      this.ctx.storage.sql.exec(
        "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
        new Date().toISOString(), row.id
      );
      return Response.json({ valid: true, key_id: row.id, scopes: JSON.parse(row.scopes) as string[] });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
