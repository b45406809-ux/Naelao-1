# Prompt 06: workers/naelao-credentials/src/ (2 files)

---
## PASTE THIS ENTIRE BLOCK INTO YOUR FREE AI
---

Platform: Naelao = multi-tenant AI agent builder on Cloudflare Workers + Durable Objects. NO Node.js, NO PostgreSQL. Data in SpaceDO SQLite (this.ctx.storage.sql). Worker comms via Service Bindings. Routing via Hono. Auth via JWT HMAC-SHA256. Billing via Lemon Squeezy (BillingProvider interface). Errors always: { error: { code: 'SNAKE_CASE', message: 'text' } }. compatibility_date: 2025-01-01.

Generate TWO files for workers/naelao-credentials/src/.

Env:
  NAELAO_MCP_MASTER_KEY: string  (32-byte hex)
  NAELAO_CONFIG_KV: KVNamespace
  NAELAO_JWT_SECRET: string
  NAELAO_ANALYTICS: AnalyticsEngineDataset

=== File 1: src/encrypt.ts ===

Per-space encryption using HKDF (NOT a single global key - this is the G-H01/G-F25 fix):

  deriveSpaceKey(masterKeyHex: string, spaceId: string): Promise<CryptoKey>
  - HKDF(masterKey, salt=UTF8(spaceId), info=UTF8('mcp-credentials-v1'), hash=SHA-256, length=256bits)
  - Uses crypto.subtle.importKey then crypto.subtle.deriveKey

  encryptCredential(value: string, masterKeyHex: string, spaceId: string): Promise<string>
  - AES-256-GCM, random 12-byte IV
  - Returns 'v1:<base64(iv+ciphertext+authTag)>'

  decryptCredential(encrypted: string, masterKeyHex: string, spaceId: string): Promise<string>
  - Parse v1: prefix, derive same space key, decrypt
  - Throws 'credential_decrypt_failed' on any error (no info leak)

=== File 2: src/index.ts ===

Hono Worker. All routes require X-Internal-Token header verified via HMAC-SHA256.
Token format: base64url(JSON{spaceId, agentId, exp}).hexSignature signed by NAELAO_JWT_SECRET.
CRITICAL: verify that spaceId in token matches :spaceId URL param before returning any credential.

Routes:
  POST /v1/credentials/:spaceId/set
    Body: { key: string; value: string; description?: string }
    Store encrypted in KV: cred:<spaceId>:<key> = { encryptedValue, description, updatedAt }

  GET /v1/credentials/:spaceId/list
    Return keys only (NOT values): { keys: Array<{ key, description, updatedAt }> }

  POST /v1/credentials/:spaceId/get
    Body: { key: string }
    CRITICAL: verify spaceId from token === URL :spaceId param
    Return { value: string } (decrypted)

  DELETE /v1/credentials/:spaceId/:key
    Delete from KV

  POST /v1/credentials/:spaceId/rotate-key
    Re-encrypt all credentials for space with bumped version
    Return { ok: true; rotated: number }

Log all access (GET operations) to NAELAO_ANALYTICS.

