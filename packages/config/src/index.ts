// Feature flags (KV-backed), env-specific config, schema validation
export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description?: string;
  rollout_pct?: number; // 0-100
}

export interface ConfigStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// KV-backed feature flag store
export class KvConfigStore implements ConfigStore {
  constructor(private readonly kv: KVNamespace, private readonly prefix: string = "config") {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(`${this.prefix}:${key}`);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
    await this.kv.put(`${this.prefix}:${key}`, JSON.stringify(value), opts);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(`${this.prefix}:${key}`);
  }
}

// Feature flag evaluation with rollout percentage
export async function isFeatureEnabled(
  store: ConfigStore,
  flagName: string,
  tenantId: string,
  defaultEnabled = false
): Promise<boolean> {
  const flag = await store.get<FeatureFlag>(`flag:${flagName}`);
  if (!flag) return defaultEnabled;
  if (!flag.enabled) return false;
  if (flag.rollout_pct === undefined || flag.rollout_pct >= 100) return true;
  // Deterministic rollout based on tenantId hash
  const hash = await hashTenantRollout(tenantId, flagName);
  return hash < flag.rollout_pct;
}

async function hashTenantRollout(tenantId: string, flagName: string): Promise<number> {
  const data = new TextEncoder().encode(`${tenantId}:${flagName}`);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const view = new DataView(hashBuf);
  return (view.getUint32(0) % 100);
}

// Typed env config with defaults
export interface EnvConfig {
  environment: "development" | "staging" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
  maxRequestBodyBytes: number;
  sessionTtlSeconds: number;
  idempotencyTtlSeconds: number;
}

export function getEnvConfig(env: Record<string, string | undefined>): EnvConfig {
  const environment = (env["ENVIRONMENT"] ?? "development") as EnvConfig["environment"];
  return {
    environment,
    logLevel: environment === "production" ? "warn" : "debug",
    maxRequestBodyBytes: 4 * 1024 * 1024, // 4MB
    sessionTtlSeconds: 30 * 24 * 60 * 60, // 30 days
    idempotencyTtlSeconds: 24 * 60 * 60,  // 24 hours
  };
}

// Validate required env variables at startup
export function requireEnvVars(env: Record<string, string | undefined>, keys: string[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
