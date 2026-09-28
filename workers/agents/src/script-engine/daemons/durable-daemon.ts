import type { DurableDaemonState } from "@naelao/agent-sdk";

export interface DaemonSql {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>;
}
export interface DaemonWorkflowInstance {
  id: string;
  status(): Promise<{ status: string; error?: unknown; output?: unknown }>;
  terminate?(): Promise<void>;
  pause?(): Promise<void>;
  resume?(): Promise<void>;
}
export interface DaemonWorkflowBinding {
  create(options: { id: string; params: Record<string, unknown> }): Promise<DaemonWorkflowInstance>;
  get(id: string): Promise<DaemonWorkflowInstance>;
}
export interface DaemonStatus {
  name: string; state: DurableDaemonState; workflowId: string | null;
  startedAt: string | null; stoppedAt: string | null; error: string | null;
}

const NAME = /^[a-z][a-z0-9_-]{1,63}$/;

/** Persistent lifecycle controller. Workflow creation returns immediately and never occupies chat CPU. */
export class DurableDaemon {
  constructor(private readonly name: string, private readonly sql: DaemonSql, private readonly workflows: DaemonWorkflowBinding) {
    if (!NAME.test(name)) throw new Error("invalid_daemon_name");
    sql.exec(`CREATE TABLE IF NOT EXISTS durable_daemons (
      name TEXT PRIMARY KEY, state TEXT NOT NULL, workflow_id TEXT,
      started_at TEXT, stopped_at TEXT, error TEXT, updated_at TEXT NOT NULL
    )`);
  }

  async start(params: Record<string, unknown> = {}): Promise<DaemonStatus> {
    const current = this.read();
    if (current?.state === "RUNNING") return await this.status();
    const now = new Date().toISOString();
    const workflowId = `daemon-${this.name}-${crypto.randomUUID()}`;
    try {
      const instance = await this.workflows.create({ id: workflowId, params: { daemon: this.name, ...params } });
      this.save("RUNNING", instance.id || workflowId, now, null, null);
    } catch (error) {
      this.save("ERROR", workflowId, now, null, error instanceof Error ? error.message : String(error));
    }
    return this.read()!;
  }

  async stop(): Promise<DaemonStatus> {
    const current = this.read();
    if (!current || current.state === "STOPPED") return current ?? this.save("STOPPED", null, null, new Date().toISOString(), null);
    try {
      if (current.workflowId) await (await this.workflows.get(current.workflowId)).terminate?.();
      return this.save("STOPPED", current.workflowId, current.startedAt, new Date().toISOString(), null);
    } catch (error) {
      return this.save("ERROR", current.workflowId, current.startedAt, null, error instanceof Error ? error.message : String(error));
    }
  }

  async pause(): Promise<DaemonStatus> {
    const current = this.read();
    if (!current?.workflowId || current.state !== "RUNNING") throw new Error("daemon_not_running");
    await (await this.workflows.get(current.workflowId)).pause?.();
    return this.save("PAUSED", current.workflowId, current.startedAt, null, null);
  }

  async status(): Promise<DaemonStatus> {
    const current = this.read() ?? this.save("STOPPED", null, null, null, null);
    if ((current.state === "RUNNING" || current.state === "PAUSED") && current.workflowId) {
      try {
        const remote = await (await this.workflows.get(current.workflowId)).status();
        if (["errored", "failed"].includes(remote.status.toLowerCase())) return this.save("ERROR", current.workflowId, current.startedAt, null, String(remote.error ?? "workflow_failed"));
        if (["complete", "terminated", "cancelled"].includes(remote.status.toLowerCase())) return this.save("STOPPED", current.workflowId, current.startedAt, new Date().toISOString(), null);
      } catch (error) { return this.save("ERROR", current.workflowId, current.startedAt, null, error instanceof Error ? error.message : String(error)); }
    }
    return current;
  }

  private read(): DaemonStatus | null {
    const row = [...this.sql.exec<{ name: string; state: DurableDaemonState; workflow_id: string | null; started_at: string | null; stopped_at: string | null; error: string | null }>("SELECT name,state,workflow_id,started_at,stopped_at,error FROM durable_daemons WHERE name = ?", this.name)][0];
    return row ? { name: row.name, state: row.state, workflowId: row.workflow_id, startedAt: row.started_at, stoppedAt: row.stopped_at, error: row.error } : null;
  }

  private save(state: DurableDaemonState, workflowId: string | null, startedAt: string | null, stoppedAt: string | null, error: string | null): DaemonStatus {
    this.sql.exec("INSERT INTO durable_daemons(name,state,workflow_id,started_at,stopped_at,error,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state,workflow_id=excluded.workflow_id,started_at=excluded.started_at,stopped_at=excluded.stopped_at,error=excluded.error,updated_at=excluded.updated_at", this.name, state, workflowId, startedAt, stoppedAt, error, new Date().toISOString());
    return { name: this.name, state, workflowId, startedAt, stoppedAt, error };
  }
}

export interface DaemonCommandTarget { start(params?: Record<string, unknown>): Promise<unknown>; stop(): Promise<unknown>; status(): Promise<unknown>; query?(term: string): Promise<unknown>; symbols?(path: string): Promise<unknown> }
export class DurableDaemonRegistry {
  private readonly targets = new Map<string, DaemonCommandTarget>();
  register(name: string, target: DaemonCommandTarget): void { if (!NAME.test(name) || this.targets.has(name)) throw new Error("invalid_or_duplicate_daemon"); this.targets.set(name, target); }
  async execute(name: string, argv: string[]): Promise<unknown> {
    const target = this.targets.get(name); if (!target) throw new Error(`daemon_not_installed:${name}`);
    const [action, ...args] = argv;
    if (action === "start") return target.start();
    if (action === "stop") return target.stop();
    if (action === "status") return target.status();
    if (action === "query" && target.query && args[0]) return target.query(args.join(" "));
    if (action === "symbols" && target.symbols && args[0]) return target.symbols(args.join(" "));
    throw new Error(`unsupported_daemon_command:${action ?? ""}`);
  }
}
