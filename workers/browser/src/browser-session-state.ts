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
const SESSION_RECORD = "browser-session";

/** Persist the R2 cleanup intent before uploading so a DO restart cannot orphan an image. */
export async function uploadScreenshotWithCleanupIntent(
  storage: BrowserStateStorage,
  record: BrowserSessionRecord,
  path: string,
  upload: () => Promise<unknown>,
  remove: () => Promise<void>,
): Promise<void> {
  await storage.transaction(async transaction => {
    const current = await transaction.get<BrowserSessionRecord>(SESSION_RECORD);
    if (!current || current.status !== "open" || !sameBrowserOwner(current.scope, record.scope)) {
      throw new Error("browser_session_closed");
    }
    const screenshots = [...current.screenshots, path];
    await transaction.put(SESSION_RECORD, { ...current, screenshots });
    record.screenshots = screenshots;
  });
  try {
    await upload();
  } catch (error) {
    // Keep the original upload failure. If R2 cleanup also fails, the durable path
    // remains in the session record for its alarm to retry.
    await discardScreenshotWithCleanupIntent(storage, path, remove).catch(() => undefined);
    throw error;
  }
}

/** Delete a pending image, then remove its cleanup intent only when deletion succeeded. */
export async function discardScreenshotWithCleanupIntent(
  storage: BrowserStateStorage,
  path: string,
  remove: () => Promise<void>,
): Promise<void> {
  await remove();
  await storage.transaction(async transaction => {
    const current = await transaction.get<BrowserSessionRecord>(SESSION_RECORD);
    if (!current || current.status !== "open" || !current.screenshots.includes(path)) return;
    await transaction.put(SESSION_RECORD, {
      ...current,
      screenshots: current.screenshots.filter(item => item !== path),
    });
  });
}

export function sameBrowserOwner(a: BrowserRuntimeScope, b: BrowserRuntimeScope): boolean {
  return ["tenantId", "spaceId", "projectId", "actorId", "agentId", "runId", "sessionId", "connectionId"].every(key => a[key as keyof BrowserRuntimeScope] === b[key as keyof BrowserRuntimeScope]);
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
