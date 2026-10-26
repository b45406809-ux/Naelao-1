import { sameEnvironmentOwner, tunnelHash, type EnvironmentOwner } from "@naelao/agent-sdk";

interface Session extends EnvironmentOwner { actorId: string; branch: string; targetId: string; createdAt: number; executionEpoch?: string; activeAction?: string; actions: number; }
interface SessionIdentity { sessionId: string; owner: EnvironmentOwner; actorId: string; branch: string; }
interface Action { digest: string; status: "prepared" | "completed" | "indeterminate"; result?: unknown; }
export interface SessionStorage {
  transaction<T>(fn: (tx: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }) => Promise<T>): Promise<T>;
}
/** Claim before dispatch. A crash leaves a prepared action that cannot be replayed or moved. */
export class ExecutionSessions {
  constructor(private readonly storage: SessionStorage) {}
  private async key(input: SessionIdentity) {
    for (const id of [input.sessionId, input.actorId]) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) throw new Error("environment_session_identity_invalid");
    return "execution-session:" + await tunnelHash(JSON.stringify([input.owner, input.actorId, input.branch, input.sessionId]));
  }
  async target(input: SessionIdentity): Promise<string | undefined> {
    const key = await this.key(input);
    return this.storage.transaction(async tx => (await tx.get<Session>(key))?.targetId);
  }
  async reconcile(input: SessionIdentity & { actionId: string }, resolve: (receipt: unknown) => Promise<{ terminal: boolean; result: unknown }>): Promise<unknown> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.actionId)) throw new Error("environment_action_invalid");
    const key = await this.key(input), actionKey = key + ":action:" + input.actionId;
    const action = await this.storage.transaction(tx => tx.get<Action>(actionKey));
    if (!action) throw new Error("environment_action_not_found");
    if (action.status === "completed") return action.result;
    if (!action.result) throw new Error("environment_action_requires_manual_reconciliation");
    const resolved = await resolve(action.result);
    if (resolved.terminal) await this.storage.transaction(async tx => {
      const current = await tx.get<Action>(actionKey);
      if (current?.digest !== action.digest) throw new Error("environment_action_conflict");
      await tx.put(actionKey, { ...action, status: "completed", result: resolved.result });
      const session = await tx.get<Session>(key);
      if (session?.activeAction === input.actionId) await tx.put(key, { ...session, activeAction: undefined });
    });
    return resolved.result;
  }
  async execute(input: { sessionId: string; actionId: string; owner: EnvironmentOwner; actorId: string; branch: string; targetId: string; command: string; workingDirectory?: string; executionEpoch?: string }, dispatch: () => Promise<unknown>): Promise<unknown> {
    for (const id of [input.sessionId, input.actionId, input.actorId, input.targetId]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) throw new Error("environment_session_identity_invalid");
    }
    if (!input.command.trim() || input.command.length > 8192) throw new Error("environment_command_invalid");
    const key = await this.key(input);
    const actionKey = key + ":action:" + input.actionId;
    if (input.workingDirectory !== undefined && (input.workingDirectory.length > 1024 || !input.workingDirectory.startsWith("/"))) throw new Error("environment_working_directory_invalid");
    const digest = await tunnelHash(JSON.stringify(input.workingDirectory === undefined ? [input.targetId, input.command] : [input.targetId, input.command, input.workingDirectory]));
    const previous = await this.storage.transaction(async tx => {
      const session = await tx.get<Session>(key);
      if (session && (!sameEnvironmentOwner(session, input.owner) || session.actorId !== input.actorId || session.branch !== input.branch || session.targetId !== input.targetId)) throw new Error("environment_session_target_conflict");
      const action = await tx.get<Action>(actionKey);
      if (action) {
        if (action.digest !== digest) throw new Error("environment_action_conflict");
        if (action.status !== "completed") throw new Error("environment_action_reconciliation_required");
        return action;
      }
      if (session && session.executionEpoch !== input.executionEpoch) throw new Error("environment_session_restore_required");
      if (session?.activeAction) throw new Error("environment_session_busy_or_unreconciled");
      if ((session?.actions ?? 0) >= 256) throw new Error("environment_session_action_limit");
      await tx.put(key, { ...input.owner, actorId: input.actorId, branch: input.branch, targetId: input.targetId, createdAt: session?.createdAt ?? Date.now(), ...(input.executionEpoch ? { executionEpoch: input.executionEpoch } : {}), activeAction: input.actionId, actions: (session?.actions ?? 0) + 1 });
      await tx.put(actionKey, { digest, status: "prepared" });
      return undefined;
    });
    if (previous) return previous.result;
    try {
      const rawResult = await dispatch();
      const serialized = JSON.stringify(rawResult ?? null);
      // Durable Object values are bounded. Preserve a completed receipt rather than leave an
      // already-executed action replayable when a tool returns a multi-megabyte log.
      const receipt = rawResult && typeof rawResult === "object" ? rawResult as Record<string, unknown> : {};
      const result = new TextEncoder().encode(serialized).byteLength <= 96 * 1024 ? rawResult
        : { status: typeof receipt.status === "string" ? receipt.status : "succeeded", ...(typeof receipt.request_id === "string" ? { request_id: receipt.request_id } : {}), ...(typeof receipt.environment_id === "string" ? { environment_id: receipt.environment_id } : {}), output_truncated: true, excerpt: serialized.slice(0, 16000), output_sha256: await tunnelHash(serialized) };
      // A tunnel accepted/sent receipt is not a completed execution; retain it without replay.
      const pending = result && typeof result === "object" && "status" in result && !["succeeded", "failed", "cancelled"].includes(String(result.status));
      await this.storage.transaction(async tx => {
        await tx.put(actionKey, { digest, status: pending ? "indeterminate" : "completed", result });
        if (!pending) { const session = await tx.get<Session>(key); if (session) await tx.put(key, { ...session, activeAction: undefined }); }
      });
      return result;
    } catch (error) {
      await this.storage.transaction(async tx => { await tx.put(actionKey, { digest, status: "indeterminate" }); });
      throw error;
    }
  }
}
