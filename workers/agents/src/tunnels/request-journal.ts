export interface TunnelRequestRecord {
  id: string; tenantId: string; spaceId: string; machineId: string; actorId: string; projectId?: string | undefined; runId: string;
  operation: string; payloadHash: string; generation: number; deadline: number;
  status: "prepared" | "sent" | "running" | "succeeded" | "failed" | "cancelled" | "indeterminate";
  nextOutputSequence: number; outputBytes: number; stdout: string; stderr: string;
  result?: unknown; error?: string | undefined; createdAt: number; updatedAt: number;
}
export interface TunnelJournalStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction<T>(fn: (tx: TunnelJournalStorage) => Promise<T>): Promise<T>;
}
export class TunnelRequestJournal {
  constructor(private readonly storage: TunnelJournalStorage) {}
  private key(id: string) { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("tunnel_request_id_invalid"); return "tunnel-request:" + id; }
  async get(id: string) { return this.storage.get<TunnelRequestRecord>(this.key(id)); }
  async prepare(record: TunnelRequestRecord, options: { activeLimit?: number } = {}): Promise<{ created: boolean; record: TunnelRequestRecord }> {
    return this.storage.transaction(async tx => {
      const key = this.key(record.id), previous = await tx.get<TunnelRequestRecord>(key);
      if (previous) {
        if (previous.payloadHash !== record.payloadHash || previous.actorId !== record.actorId || previous.runId !== record.runId || previous.projectId !== record.projectId
          || previous.tenantId !== record.tenantId || previous.spaceId !== record.spaceId || previous.machineId !== record.machineId) throw new Error("tunnel_request_conflict");
        return { created: false, record: previous };
      }
      if (options.activeLimit !== undefined) {
        const active = await tx.get<string[]>("active_requests") ?? [];
        if (!Number.isSafeInteger(options.activeLimit) || options.activeLimit < 1 ||
            (active.length >= options.activeLimit && !active.includes(record.id)))
          throw new Error("tunnel_machine_concurrency_limit");
        if (!active.includes(record.id)) await tx.put("active_requests", [...active, record.id]);
      }
      await tx.put(key, record);
      return { created: true, record };
    });
  }
  async update(id: string, generation: number, patch: Partial<Pick<TunnelRequestRecord, "status" | "result" | "error">>): Promise<TunnelRequestRecord> {
    return this.storage.transaction(async tx => {
      const key = this.key(id), record = await tx.get<TunnelRequestRecord>(key);
      if (!record || record.generation !== generation) throw new Error("tunnel_stale_socket");
      if (["succeeded", "failed", "cancelled"].includes(record.status)) return record;
      // A late authenticated result can reconcile an indeterminate command; never re-send it.
      const next = { ...record, ...patch, updatedAt: Date.now() };
      await tx.put(key, next); return next;
    });
  }
  async output(id: string, generation: number, sequence: number, stream: "stdout" | "stderr", chunk: string): Promise<TunnelRequestRecord> {
    return this.storage.transaction(async tx => {
      const key = this.key(id), record = await tx.get<TunnelRequestRecord>(key);
      if (!record || record.generation !== generation) throw new Error("tunnel_stale_socket");
      if (!["sent", "running"].includes(record.status)) throw new Error("tunnel_output_after_terminal");
      if (sequence < record.nextOutputSequence) return record;
      if (sequence !== record.nextOutputSequence) throw new Error("tunnel_output_sequence_gap");
      const bytes = new TextEncoder().encode(chunk).byteLength;
      if (bytes > 16384 || record.outputBytes + bytes > 1048576) throw new Error("tunnel_output_limit");
      const next = { ...record, status: "running" as const, outputBytes: record.outputBytes + bytes, nextOutputSequence: sequence + 1,
        [stream]: record[stream] + chunk, updatedAt: Date.now() };
      await tx.put(key, next); return next;
    });
  }
}
