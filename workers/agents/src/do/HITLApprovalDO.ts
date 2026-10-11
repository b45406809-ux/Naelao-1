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
//
// WS-7 (audit plan) — DO-naming exception, documented not normalized: addressed by plain
// `idFromName(\`hitl:${spaceId}\`)`, not the HMAC-SHA256(tenantId, secret):type:id convention
// SpaceDO/NaelaoAgentDO use (G-BA01). Accepted because spaceId is always server-derived from an
// already-authenticated request, never a client-controlled value passed straight through — the
// same rationale as TaskDO's exception (see its file header for the full writeup). Normalizing
// would need a live-migration plan for already-provisioned instances; deferred, not dropped.

import { DurableObject } from "cloudflare:workers";

const AUTO_REJECT_MS = 30_000;

type ApprovalStatus = "pending" | "approved" | "answered" | "rejected" | "timeout";

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
  // §A1.17 Phase O: set the first (and only) time an approved request is redeemed via
  // /requests/:id/consume — a Bearer nak_... agent's own resubmitted HTTP request, not the
  // in-loop reasoning gate (which never calls consume; it just polls until resolved). Without
  // this, the same approval_id could authorize an unbounded number of later, different requests.
  consumed_at: string | null;
  // The Durable Object id (stringified) of the agent DO whose reasoning loop opened this
  // request, when one did. A run can suspend waiting for a human, and the checkpoint that lets
  // it continue lives in THAT DO — which is addressed per space:project:thread, so it cannot be
  // rederived from the space alone. Null for approvals opened outside a loop (the Phase O
  // HTTP agent-key gate), which have no run to resume.
  resume_do_id: string | null;
  kind: "approval" | "question";
  question: string | null;
  options_json: string | null;
  questions_json: string | null;
  answer: string | null;
}

export class HITLApprovalDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
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
        expires_at         INTEGER NOT NULL,
        consumed_at        TEXT,
        resume_do_id       TEXT,
        kind               TEXT NOT NULL DEFAULT 'approval',
        question           TEXT,
        options_json       TEXT,
        questions_json     TEXT,
        answer             TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);
    `);
    // CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists, so an instance
    // created before resume_do_id existed would never gain the column. Adding it here rather than
    // silently running without it — the same forward-fix shape migration 0048 used for the
    // api_keys table this exact mistake had already broken once.
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE approvals ADD COLUMN resume_do_id TEXT`);
    } catch {
      /* already present — the ordinary case on every wake-up after the first */
    }
    for (const migration of [
      "ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval'",
      "ALTER TABLE approvals ADD COLUMN question TEXT",
      "ALTER TABLE approvals ADD COLUMN options_json TEXT",
      "ALTER TABLE approvals ADD COLUMN questions_json TEXT",
      "ALTER TABLE approvals ADD COLUMN answer TEXT",
    ]) {
      try { this.ctx.storage.sql.exec(migration); } catch { /* already present */ }
    }
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // POST /requests — create a new approval request. ttl_ms lets a caller outside the in-loop
    // reasoning gate (§A1.17 Phase O's HTTP-level agent-key approval gate) ask for a realistic
    // human-review window instead of the 30s default the reasoning loop's own synchronous poll
    // was tuned for.
    if (method === "POST" && url.pathname === "/requests") {
      const body = await request.json<{
        run_id: string;
        session_id: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
        action_description: string;
        kind?: "approval" | "question";
        question?: string;
        options?: string[];
        questions?: Array<{ question: string; options?: string[] }>;
        ttl_ms?: number;
        resume_do_id?: string;
      }>();

      if (!body.run_id || !body.tool_name) {
        return Response.json({ error: "run_id and tool_name required" }, { status: 400 });
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const expiresAt = Date.now() + (body.ttl_ms && body.ttl_ms > 0 ? body.ttl_ms : AUTO_REJECT_MS);

      this.ctx.storage.sql.exec(
        `INSERT INTO approvals (id, run_id, session_id, tool_name, tool_input, action_description, status, created_at, expires_at, resume_do_id, kind, question, options_json, questions_json)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        id, body.run_id, body.session_id, body.tool_name,
        JSON.stringify(body.tool_input ?? {}),
        body.action_description, now, expiresAt, body.resume_do_id ?? null,
        body.kind ?? "approval", body.question ?? null,
        body.options?.length ? JSON.stringify(body.options.slice(0, 8)) : null,
        body.questions?.length ? JSON.stringify(body.questions.slice(0, 5)) : null
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

    // PUT /requests/:questionId/answer — resolve a planner questionnaire.
    const answerMatch = url.pathname.match(/^\/requests\/([^/]+)\/answer$/);
    if (method === "PUT" && answerMatch?.[1]) {
      const body = await request.json<{ answer?: string }>().catch(() => ({ answer: undefined }));
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      if (!answer) return Response.json({ error: "answer is required" }, { status: 400 });
      const rows = this.ctx.storage.sql
        .exec(`SELECT id, status, kind FROM approvals WHERE id = ?`, answerMatch[1])
        .toArray() as unknown as Array<{ id: string; status: string; kind: string }>;
      if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
      if (rows[0].kind !== "question") return Response.json({ error: "not_a_question" }, { status: 400 });
      if (rows[0].status !== "pending") return Response.json({ error: "already_resolved", current_status: rows[0].status }, { status: 409 });
      this.ctx.storage.sql.exec(
        `UPDATE approvals SET status = 'answered', answer = ?, resolved_at = ? WHERE id = ?`,
        answer.slice(0, 4000), new Date().toISOString(), answerMatch[1]
      );
      return Response.json({ id: answerMatch[1], status: "answered" });
    }

    // POST /requests/:approvalId/consume — §A1.17 Phase O: single-use redemption of an
    // APPROVED request by the router's agent-key gate, once the agent's caller resubmits the
    // original request with X-Naelao-Approval-Id. The read-then-write below is safe from a
    // double-consume race WITHOUT needing to inspect the UPDATE's affected-row count: a
    // Durable Object processes one request to completion before starting the next (CF's
    // single-threaded-per-instance guarantee), so a second concurrent /consume call can only
    // ever observe this row AFTER the first call's UPDATE has already committed — it will see
    // consumed_at already set and be rejected by the check above, never racing the WHERE clause
    // itself. run_id/tool_name must match the EXACT agent+action this approval was opened for,
    // so an approval granted for one action can never be replayed against a different one.
    const consumeMatch = url.pathname.match(/^\/requests\/([^/]+)\/consume$/);
    if (method === "POST" && consumeMatch?.[1]) {
      const body = await request.json<{ run_id?: string; tool_name?: string }>().catch(() => ({}) as Record<string, never>);
      const row = this.ctx.storage.sql
        .exec(`SELECT * FROM approvals WHERE id = ?`, consumeMatch[1])
        .toArray() as unknown as ApprovalRow[];
      const approval = row[0];
      if (!approval) return Response.json({ consumed: false, reason: "not_found" });
      if (approval.status === "pending" && approval.expires_at < Date.now()) this.expireApproval(approval.id);
      if (approval.status !== "approved" || approval.consumed_at) {
        return Response.json({ consumed: false, reason: approval.consumed_at ? "already_consumed" : "not_approved" });
      }
      if (body.run_id && approval.run_id !== body.run_id) return Response.json({ consumed: false, reason: "run_id_mismatch" });
      if (body.tool_name && approval.tool_name !== body.tool_name) return Response.json({ consumed: false, reason: "action_mismatch" });
      this.ctx.storage.sql.exec(
        `UPDATE approvals SET consumed_at = ? WHERE id = ? AND status = 'approved' AND consumed_at IS NULL`,
        new Date().toISOString(), approval.id
      );
      return Response.json({ consumed: true });
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

  /**
   * An approval nobody answered in time. Deliberately NOT phrased as a rejection: the reason text
   * used to say "Auto-rejected", which the agent then reported to the user as though they had
   * declined. Nobody declined anything — the request simply wasn't seen. Those are different
   * facts, and only one of them means "don't ask again".
   */
  private expireApproval(id: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE approvals SET status = 'timeout', reject_reason = ?, resolved_at = ? WHERE id = ?`,
      "No answer yet — this request expired before anyone approved or declined it.",
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
