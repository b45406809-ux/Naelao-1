import type { BrowserObservation, BrowserRuntimeScope, BrowserScopedAction } from "@naelao/agent-sdk";

export interface BrowserActionRecord {
  digest: string; status: "prepared" | "committed" | "indeterminate"; result?: BrowserObservation;
}
export interface BrowserSessionRecord {
  scope: BrowserRuntimeScope; status: "open" | "closed"; providerSessionId?: string;
  engine: "kitesurf" | "chromium"; url: string; observation?: BrowserObservation;
  cookies?: unknown[]; actions: number; screenshots: string[]; lastUsedAt: number;
}
export interface BrowserStateStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction<T>(callback: (storage: Pick<BrowserStateStorage, "get" | "put">) => Promise<T>): Promise<T>;
}
export function sameBrowserOwner(a: BrowserRuntimeScope, b: BrowserRuntimeScope): boolean {
  return ["tenantId", "spaceId", "projectId", "actorId", "agentId", "runId", "sessionId"].every(key => a[key as keyof BrowserRuntimeScope] === b[key as keyof BrowserRuntimeScope]);
}
/** Prepared mutations never replay blindly after a lost response or runtime restart. */
export class BrowserActionJournal {
  constructor(private readonly storage: BrowserStateStorage) {}
  async claim(action: BrowserScopedAction): Promise<{ created: boolean; record: BrowserActionRecord }> {
    const bytes = new TextEncoder().encode(JSON.stringify(action));
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return this.storage.transaction(async storage => {
      const key = "action:" + action.actionId;
      const existing = await storage.get<BrowserActionRecord>(key);
      if (existing) {
        if (existing.digest !== digest) throw new Error("browser_action_id_conflict");
        return { created: false, record: existing };
      }
      const record: BrowserActionRecord = { digest, status: "prepared" };
      await storage.put(key, record);
      return { created: true, record };
    });
  }
  async finish(id: string, result?: BrowserObservation): Promise<void> {
    await this.storage.transaction(async storage => {
      const key = "action:" + id, record = await storage.get<BrowserActionRecord>(key);
      if (!record || record.status === "committed") return;
      await storage.put(key, { ...record, status: result ? "committed" : "indeterminate", ...(result ? { result } : {}) });
    });
  }
}
