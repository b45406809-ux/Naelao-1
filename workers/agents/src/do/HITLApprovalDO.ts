// G-AY01: Human-in-the-Loop (HITL) Approval Durable Object.
//
// When an agent tool is marked require_approval:true, the AgentDO:
//   1. Creates an approval request here (POST /requests)
//   2. Transitions FSM to AWAITING_HUMAN
//   3. Sets a 30s alarm for auto-reject
//
// Builder approves or rejects via:
//   PUT /requests/:approvalId/approve   → { approved: true }
//   PUT /requests/:approvalId/reject    → { approved: false, reason }
//
// Agent resumes by polling GET /requests/:approvalId.
//
// One HITLApprovalDO per Space (named by spaceId).

import { DurableObject } from "cloudflare:workers";

const AUTO_REJECT_MS = 30_000;

type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

interface ApprovalRow {
  id: string;
  run_id: string;
  session_id: string;
  tool_name: string;
  tool_input: string;   // JSON
  action_description: string;
  status: ApprovalStatus;
  reject_reason: string | null;
  created_at: string;
  resolved_at: string | null;
  expires_at: number;   // unix ms
}

export class HITLApprovalDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id                 TEXT PRIMARY KEY,
        run_id             TEXT NOT NULL,
        session_id         TEXT NOT NULL,
        tool_name          TEXT NOT NULL,
        tool_input         TEXT NOT NULL DEFAULT '{}',
        action_description TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        reject_reason      TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at        TEXT,
        expires_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // POST /requests — create a new approval request
    if (method === "POST" && url.pathname === "/requests") {
      const body = await request.json<{
        run_id: string;
        session_id: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
        action_description: string;
      }>();

      if (!body.run_id || !body.tool_name) {
        return Response.json({ error: "run_id and tool_name required" }, { status: 400 });
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const expiresAt = Date.now() + AUTO_REJECT_MS;

      this.ctx.storage.sql.exec(
        `INSERT INTO approvals (id, run_id, session_id, tool_name, tool_input, action_description, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id, body.run_id, body.session_id, body.tool_name,
        JSON.stringify(body.tool_input ?? {}),
        body.action_description, now, expiresAt
      );

      // Set alarm to auto-reject when TTL expires
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (!existingAlarm || existingAlarm > expiresAt) {
        await this.ctx.storage.setAlarm(expiresAt);
      }

      return Response.json({ approval_id: id, expires_at: new Date(expiresAt).toISOString() }, { status: 201 });
    }

    // GET /requests/:approvalId — poll for approval status
    const approvalMatch = url.pathname.match(/^\/requests\/([^/]+)$/);
    if (method === "GET" && approvalMatch?.[1]) {
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM approvals WHERE id = ?`, approvalMatch[1])
        .toArray() as unknown as ApprovalRow[];
      if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });

      const row = rows[0];
      // Check if expired but not yet processed by alarm
      if (row.status === "pending" && row.expires_at < Date.now()) {
        this.expireApproval(row.id);
        return Response.json({ ...row, status: "timeout" as ApprovalStatus });
      }
      return Response.json(row);
    }

    // GET /requests — list pending approvals for a run
    if (method === "GET" && url.pathname === "/requests") {
      const runId = url.searchParams.get("run_id");
      const rows = runId
        ? this.ctx.storage.sql
            .exec(`SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC`, runId)
            .toArray() as unknown as ApprovalRow[]
        : this.ctx.storage.sql
            .exec(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`)
            .toArray() as unknown as ApprovalRow[];
      return Response.json({ approvals: rows });
    }

    // PUT /requests/:approvalId/approve
    const approveMatch = url.pathname.match(/^\/requests\/([^/]+)\/approve$/);
    if (method === "PUT" && approveMatch?.[1]) {
      return this.resolveApproval(approveMatch[1], "approved", null);
    }

    // PUT /requests/:approvalId/reject
    const rejectMatch = url.pathname.match(/^\/requests\/([^/]+)\/reject$/);
    if (method === "PUT" && rejectMatch?.[1]) {
      const body = await request.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
      return this.resolveApproval(rejectMatch[1], "rejected", (body as { reason?: string }).reason ?? "Builder rejected");
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private resolveApproval(id: string, status: "approved" | "rejected", reason: string | null): Response {
    const rows = this.ctx.storage.sql
      .exec(`SELECT id, status FROM approvals WHERE id = ?`, id)
      .toArray() as unknown as { id: string; status: string }[];
    if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
    if (rows[0].status !== "pending") {
      return Response.json({ error: "already_resolved", current_status: rows[0].status }, { status: 409 });
    }
    this.ctx.storage.sql.exec(
      `UPDATE approvals SET status = ?, reject_reason = ?, resolved_at = ? WHERE id = ?`,
      status, reason, new Date().toISOString(), id
    );
    return Response.json({ id, status });
  }

  private expireApproval(id: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE approvals SET status = 'timeout', reject_reason = 'Auto-rejected: 30s approval timeout', resolved_at = ? WHERE id = ?`,
      new Date().toISOString(), id
    );
  }

  override async alarm(): Promise<void> {
    this.ensureInit();
    const nowMs = Date.now();
    const expired = this.ctx.storage.sql
      .exec(`SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ?`, nowMs)
      .toArray() as unknown as { id: string }[];

    for (const row of expired) {
      this.expireApproval(row.id);
    }

    // Re-arm alarm if there are more pending approvals
    const nextPending = this.ctx.storage.sql
      .exec(`SELECT MIN(expires_at) as next_exp FROM approvals WHERE status = 'pending'`)
      .toArray() as unknown as { next_exp: number | null }[];

    const nextExp = nextPending[0]?.next_exp;
    if (nextExp) {
      await this.ctx.storage.setAlarm(nextExp);
    }
  }
}
