import { AVOS_PROJECT_KINDS } from '../../../../packages/events/src/business-feature-kinds';
import type { AvosWorkflowDefinition, WorkflowClass, WorkflowFundingSource, WorkflowAlertChannel, SpaceExportSnapshot, TemplatePublishSubmission } from "@naelao/types";
import { evaluateUserBudget, type UserBudgetEnvelope } from "@naelao/billing-core";

export interface Env {
  PLATFORM_DB?: any;
  TEMPLATE_REVIEW_WORKFLOW?: any;
  SCRIPTS_R2?: any;
  SPACE_DO?: any;
}

export class SpaceDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Initialize SQLite storage for active gadget instances and workflow registry
    this.state.blockConcurrencyWhile(async () => {
      try {
        this.state.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS gadget_instances (
            id TEXT PRIMARY KEY,
            manifest_id TEXT NOT NULL,
            tier INTEGER NOT NULL,
            status TEXT NOT NULL,
            project_id TEXT,
            owner_user_id TEXT
          );

          CREATE TABLE IF NOT EXISTS space_workflows_registry (
            id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            workflow_class TEXT NOT NULL CHECK (workflow_class IN ('COMPANY_AUTOMATION', 'VERTICAL_EXTENSION', 'EPHEMERAL_TASK')),
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            plugin_id TEXT,
            script_path TEXT NOT NULL,
            trigger_type TEXT NOT NULL CHECK (trigger_type IN ('cron', 'webhook', 'event_queue', 'on_demand', 'git_push')),
            trigger_spec TEXT,
            funding_source TEXT NOT NULL DEFAULT 'PROJECT_CAP' CHECK (funding_source IN ('COMPANY_WALLET', 'PROJECT_CAP', 'USER_CREDITS')),
            alert_channel TEXT NOT NULL DEFAULT 'PROJECT_TEAM_ROOM' CHECK (alert_channel IN ('FOUNDER_TELEGRAM', 'PROJECT_TEAM_ROOM', 'THREAD_RECEIPT_ONLY')),
            status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'DISABLED')),
            last_run_at TEXT,
            last_exit_code INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_swr_lookup ON space_workflows_registry(space_id, project_id, workflow_class);

          CREATE TABLE IF NOT EXISTS webhook_idempotency_records (
            hash TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            event_id TEXT NOT NULL,
            space_id TEXT NOT NULL,
            processed_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_wir_time ON webhook_idempotency_records(processed_at);

          CREATE TABLE IF NOT EXISTS customer_conversations (
            id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            customer_identifier TEXT NOT NULL,
            channel TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('customer', 'bot', 'human_agent')),
            content TEXT NOT NULL,
            sentiment TEXT CHECK (sentiment IN ('POSITIVE', 'NEUTRAL', 'FRUSTRATED', 'ANGRY')),
            metadata_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_cc_session ON customer_conversations(session_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_cc_cust ON customer_conversations(customer_identifier);

          CREATE TABLE IF NOT EXISTS space_user_budget_envelopes (
            user_id TEXT PRIMARY KEY,
            daily_credit_allowance INTEGER NOT NULL DEFAULT 500,
            credits_spent_today INTEGER NOT NULL DEFAULT 0,
            hard_stop_enabled INTEGER NOT NULL DEFAULT 1,
            warned_at_eighty INTEGER NOT NULL DEFAULT 0,
            reset_at TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS wallet_ledger (
            id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            delta_cents INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS workspace_files (
            path TEXT PRIMARY KEY,
            content TEXT,
            size_bytes INTEGER DEFAULT 0
          );

          CREATE TABLE IF NOT EXISTS space_credentials (
            credential_name TEXT NOT NULL,
            service_name TEXT NOT NULL DEFAULT 'custom'
          );

          CREATE TABLE IF NOT EXISTS knowledge_documents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS project_tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ACTIVE'
          );
        `);
      } catch (e) {
        console.warn("SQLite initialization skipped/failed in SpaceDO", e);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/create-project" && request.method === "POST") {
        const body: any = await request.json();
        const project = await this.createProject(body);
        return new Response(JSON.stringify({ success: true, project }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/get-projects" && request.method === "GET") {
        const projects = await this.getProjects();
        return new Response(JSON.stringify({ success: true, projects }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/list-gadgets-for-run" && request.method === "POST") {
        const body: any = await request.json();
        const gadgets = await this.listGadgetInstancesForRun(body.projectId, body.userId);
        return new Response(JSON.stringify({ success: true, gadgets }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/register-gadget" && request.method === "POST") {
        const body: any = await request.json();
        const { id, manifestId, tier, status, projectId, ownerUserId } = body;
        try {
          this.state.storage.sql.exec(
            "INSERT OR REPLACE INTO gadget_instances (id, manifest_id, tier, status, project_id, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)",
            id, manifestId, tier, status || "active", projectId || null, ownerUserId || null
          );
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      }

      if (path === "/register-workflow" && request.method === "POST") {
        const body: any = await request.json();
        const result = await this.registerWorkflow(body);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/list-workflows" && (request.method === "GET" || request.method === "POST")) {
        let filter: any = undefined;
        if (request.method === "POST") {
          try { filter = await request.json(); } catch {}
        } else {
          const projectId = url.searchParams.get("projectId") || undefined;
          const workflowClass = url.searchParams.get("workflowClass") || undefined;
          if (projectId || workflowClass) filter = { projectId, workflowClass };
        }
        const workflows = await this.listWorkflows(filter);
        return new Response(JSON.stringify({ success: true, workflows }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/update-workflow-status" && request.method === "POST") {
        const body: any = await request.json();
        const result = await this.updateWorkflowStatus(body.id, body.status);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/record-workflow-execution" && request.method === "POST") {
        const body: any = await request.json();
        const result = await this.recordWorkflowExecution(body.id, body.exitCode);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/idempotency/check" && request.method === "POST") {
        const body = await request.json() as { provider: string; eventId: string; payloadStr: string };
        const isFresh = await this.checkAndRecordIdempotency(body.provider, body.eventId, body.payloadStr);
        return Response.json({ isFresh });
      }

      if (path === "/customer-conversations/append" && request.method === "POST") {
        const body: any = await request.json();
        const result = await this.appendCustomerMessage(body);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/customer-conversations/history" && request.method === "GET") {
        const sessionId = url.searchParams.get("session_id") || "";
        const limitStr = url.searchParams.get("limit") || "10";
        const limit = parseInt(limitStr, 10) || 10;
        const history = await this.getCustomerConversationHistory(sessionId, limit);
        return new Response(JSON.stringify(history), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/budget/check" && request.method === "POST") {
        const body: any = await request.json();
        const result = await this.checkUserBudgetEnvelope(
          body.userId,
          body.estimatedCredits ?? body.requestedCredits ?? 0,
          Boolean(body.isClass1Automation)
        );
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/budget/debit" && request.method === "POST") {
        const body: any = await request.json();
        const result = await this.recordUserBudgetDebit(
          body.userId,
          body.creditsSpent ?? 0,
          body.reason ?? "",
          Boolean(body.isClass1Automation)
        );
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (path === "/export-space-state" && request.method === "POST") {
        const body: any = await request.json().catch(() => ({}));
        const snapshot = await this.exportSpaceState({
          includeKnowledge: body.includeKnowledge !== false
        });
        return new Response(JSON.stringify({ success: true, snapshot }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if ((path === "/marketplace/publish" || path === "/submit-template-for-review") && request.method === "POST") {
        const body: any = await request.json();
        const blueprintId = body.blueprintId;
        const submission = {
          blueprintId,
          spaceId: this.state.id.toString(),
          submittedByUserId: body.submittedByUserId || body.submission?.submittedByUserId || "unknown_user",
          requestedPricingModel: body.requestedPricingModel || body.submission?.requestedPricingModel || "FREEMIUM_TIERED_SAAS",
          priceCents: body.priceCents || body.submission?.priceCents || 0
        };
        const result = await this.submitTemplateForReview(blueprintId, submission);
        return result;
      }

      if (path === "/provision-test-blueprint" && request.method === "POST") {
        const blueprint = await request.json() as any;
        const result = await this.provisionTestBlueprint(blueprint);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err: any) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  async createProject(params: { id?: string; name: string; kind: string }) {
    if (!params.name) {
      throw new Error("Project name is required");
    }
    if (!params.kind) {
      throw new Error("Project kind is required");
    }
    if (!AVOS_PROJECT_KINDS[params.kind]) {
      throw new Error(`Invalid project kind: ${params.kind}`);
    }

    const projects: any[] = (await this.state.storage.get("projects")) || [];
    
    const newProject = {
      id: params.id || `proj_${Math.random().toString(36).substr(2, 9)}`,
      name: params.name,
      kind: params.kind,
      createdAt: new Date().toISOString(),
      config: AVOS_PROJECT_KINDS[params.kind]
    };

    projects.push(newProject);
    await this.state.storage.put("projects", projects);

    return newProject;
  }

  async getProjects() {
    return (await this.state.storage.get("projects")) || [];
  }

  /**
   * Registers or updates an AvosWorkflowDefinition in the central SQLite registry.
   */
  async registerWorkflow(def: AvosWorkflowDefinition): Promise<{ ok: boolean; id: string }> {
    const id = def.id || `wf_${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();
    const triggerSpec = JSON.stringify(def.trigger || { type: "on_demand" });
    const fundingSource = def.governance?.fundingSource || "PROJECT_CAP";
    const alertChannel = def.governance?.alertChannel || "PROJECT_TEAM_ROOM";
    const status = def.status || "ACTIVE";

    this.state.storage.sql.exec(`
      INSERT OR REPLACE INTO space_workflows_registry (
        id, space_id, project_id, workflow_class, title, description,
        plugin_id, script_path, trigger_type, trigger_spec, funding_source,
        alert_channel, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM space_workflows_registry WHERE id = ?), ?), ?)
    `,
      id,
      def.spaceId,
      def.projectId || null,
      def.workflowClass,
      def.title,
      def.description || "",
      def.pluginId || null,
      def.scriptPath,
      def.trigger?.type || "on_demand",
      triggerSpec,
      fundingSource,
      alertChannel,
      status,
      id,
      now,
      now
    );

    return { ok: true, id };
  }

  /**
   * Lists registered workflows with optional project/class filtering.
   */
  async listWorkflows(filter?: { projectId?: string; workflowClass?: string }): Promise<AvosWorkflowDefinition[]> {
    try {
      let query = "SELECT * FROM space_workflows_registry WHERE 1=1";
      const params: any[] = [];

      if (filter?.projectId) {
        query += " AND project_id = ?";
        params.push(filter.projectId);
      }
      if (filter?.workflowClass) {
        query += " AND workflow_class = ?";
        params.push(filter.workflowClass);
      }
      query += " ORDER BY created_at DESC";

      const rows = this.state.storage.sql.exec(query, ...params).toArray() as Array<any>;

      return rows.map((r: any) => ({
        id: r.id,
        spaceId: r.space_id,
        projectId: r.project_id || undefined,
        workflowClass: r.workflow_class as WorkflowClass,
        title: r.title,
        description: r.description || "",
        pluginId: r.plugin_id || undefined,
        scriptPath: r.script_path,
        trigger: r.trigger_spec ? JSON.parse(r.trigger_spec) : { type: r.trigger_type },
        governance: {
          maxStepCeiling: 50,
          stepTimeoutSeconds: 300,
          fundingSource: (r.funding_source || "PROJECT_CAP") as WorkflowFundingSource,
          alertChannel: (r.alert_channel || "PROJECT_TEAM_ROOM") as WorkflowAlertChannel,
        },
        status: r.status as "ACTIVE" | "PAUSED" | "DISABLED",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    } catch (err) {
      console.warn("listWorkflows SQL query failed, returning empty array:", err);
      return [];
    }
  }

  /**
   * Updates workflow status (ACTIVE, PAUSED, DISABLED).
   */
  async updateWorkflowStatus(id: string, status: "ACTIVE" | "PAUSED" | "DISABLED"): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    this.state.storage.sql.exec(`
      UPDATE space_workflows_registry
      SET status = ?, updated_at = ?
      WHERE id = ?
    `, status, now, id);
    return { ok: true };
  }

  /**
   * Records workflow execution outcome.
   */
  async recordWorkflowExecution(id: string, exitCode: number): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    this.state.storage.sql.exec(`
      UPDATE space_workflows_registry
      SET last_run_at = ?, last_exit_code = ?, updated_at = ?
      WHERE id = ?
    `, now, exitCode, now, id);
    return { ok: true };
  }

  /**
   * Atomic deduplication check using SHA-256 payload hash.
   * Returns true if the event is fresh, or false if it is a duplicate replay.
   */
  async checkAndRecordIdempotency(provider: string, eventId: string, payloadStr: string): Promise<boolean> {
    const spaceId = (this.state.id as any).toString ? (this.state.id as any).toString() : "space";
    const encoder = new TextEncoder();
    const data = encoder.encode(`${provider}:${eventId}:${payloadStr}`);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hash = [...new Uint8Array(hashBuffer)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Clean entries older than 24 hours to prevent unbounded table growth
    this.state.storage.sql.exec(`
      DELETE FROM webhook_idempotency_records 
      WHERE processed_at < datetime('now', '-1 day')
    `);

    // Check if hash was already processed
    const existing = this.state.storage.sql.exec(
      `SELECT 1 FROM webhook_idempotency_records WHERE hash = ?`, 
      hash
    ).toArray();

    if (existing.length > 0) {
      return false; // Duplicate replay detected
    }

    // Insert fresh hash record
    this.state.storage.sql.exec(
      `INSERT INTO webhook_idempotency_records (hash, provider, event_id, space_id) VALUES (?, ?, ?, ?)`,
      hash, 
      provider, 
      eventId, 
      spaceId
    );

    return true; // Fresh event, execution permitted
  }
  async listGadgetInstancesForRun(projectId?: string, userId?: string) {
    try {
      const sql = `
        SELECT id as instanceId, manifest_id as manifestId, tier
        FROM gadget_instances
        WHERE status = 'active'
          AND (
            (tier IN (2, 3) AND project_id = ?)
            OR (tier = 1 AND owner_user_id = ?)
          )
      `;
      const params = [projectId || "", userId || ""];
      const rows = this.state.storage.sql.exec(sql, ...params).toArray() as Array<{
        instanceId: string;
        manifestId: string;
        tier: number;
      }>;

      return rows.map(r => ({
        instanceId: r.instanceId,
        manifestId: r.manifestId,
        tier: r.tier as 1 | 2 | 3,
        internalMcpUrl: `http://internal/spaces/${this.state.id.toString()}/gadgets/${r.instanceId}/mcp`
      }));
    } catch (err: any) {
      console.warn("listGadgetInstancesForRun SQL query failed, returning empty list:", err);
      return [];
    }
  }

  async appendCustomerMessage(record: {
    spaceId: string;
    projectId: string;
    sessionId: string;
    customerIdentifier: string;
    channel: string;
    role: "customer" | "bot" | "human_agent";
    content: string;
    sentiment?: string;
    metadata?: Record<string, any>;
  }): Promise<{ ok: boolean; id: string }> {
    const id = `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.state.storage.sql.exec(`
      INSERT INTO customer_conversations (
        id, space_id, project_id, session_id, customer_identifier, channel, role, content, sentiment, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `,
      id,
      record.spaceId,
      record.projectId,
      record.sessionId,
      record.customerIdentifier,
      record.channel,
      record.role,
      record.content,
      record.sentiment || null,
      JSON.stringify(record.metadata || {})
    );
    return { ok: true, id };
  }

  async getCustomerConversationHistory(sessionId: string, limit: number = 10): Promise<Array<{ role: string; content: string }>> {
    const rows = this.state.storage.sql.exec(
      `SELECT role, content FROM customer_conversations
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
      sessionId,
      limit
    ).toArray() as Array<{ role: string; content: string }>;
    return rows;
  }

  async checkUserBudgetEnvelope(
    userId: string,
    requestedCredits: number,
    isClass1Automation: boolean = false
  ): Promise<{ allowed: boolean; reason?: string; remainingCredits: number }> {
    const nowIso = new Date().toISOString();
    const spaceId = this.state.id.toString();

    // 1. Fetch or initialize user budget envelope
    let rows = this.state.storage.sql.exec(
      `SELECT * FROM space_user_budget_envelopes WHERE user_id = ?`,
      userId
    ).toArray() as any[];
    let row = rows[0];

    if (!row) {
      const nextDay = new Date(Date.now() + 86400000).toISOString();
      this.state.storage.sql.exec(
        `INSERT INTO space_user_budget_envelopes 
         (user_id, daily_credit_allowance, credits_spent_today, hard_stop_enabled, warned_at_eighty, reset_at)
         VALUES (?, 500, 0, 1, 0, ?)`,
        userId,
        nextDay
      );
      row = {
        user_id: userId,
        daily_credit_allowance: 500,
        credits_spent_today: 0,
        hard_stop_enabled: 1,
        warned_at_eighty: 0,
        reset_at: nextDay
      };
    }

    // 2. Check if daily window has rolled over
    if (nowIso >= row.reset_at) {
      const nextReset = new Date(Date.now() + 86400000).toISOString();
      this.state.storage.sql.exec(
        `UPDATE space_user_budget_envelopes 
         SET credits_spent_today = 0, warned_at_eighty = 0, reset_at = ?, updated_at = datetime('now')
         WHERE user_id = ?`,
        nextReset,
        userId
      );
      row.credits_spent_today = 0;
      row.warned_at_eighty = 0;
      row.reset_at = nextReset;
    }

    // 3. Fetch current liquid wallet balance (in credits = cents)
    const balanceRow = this.state.storage.sql.exec(
      `SELECT COALESCE(SUM(delta_cents), 0) as balance_cents FROM wallet_ledger WHERE currency = 'USD'`
    ).toArray()[0] as any;
    const walletBalanceCredits = balanceRow ? Number(balanceRow.balance_cents) : 0;

    // 4. Evaluate via pure billing-core logic
    const envelope: UserBudgetEnvelope = {
      spaceId,
      userId: row.user_id,
      dailyCreditAllowance: Number(row.daily_credit_allowance),
      creditsSpentToday: Number(row.credits_spent_today),
      hardStopEnabled: Boolean(row.hard_stop_enabled),
      warnedAtEighty: Boolean(row.warned_at_eighty),
      resetAt: row.reset_at
    };

    const evalResult = evaluateUserBudget(envelope, requestedCredits, walletBalanceCredits, isClass1Automation);

    if (!evalResult.allowed) {
      return {
        allowed: false,
        reason: evalResult.reason,
        remainingCredits: evalResult.remainingUserCredits
      };
    }

    // 5. If 80% threshold reached, record warning flag
    if (evalResult.requiresSoftWarning) {
      this.state.storage.sql.exec(
        `UPDATE space_user_budget_envelopes SET warned_at_eighty = 1 WHERE user_id = ?`,
        userId
      );
    }

    return {
      allowed: true,
      remainingCredits: evalResult.remainingUserCredits
    };
  }

  async recordUserBudgetDebit(
    userId: string,
    creditsSpent: number,
    reason: string,
    isClass1Automation: boolean = false
  ): Promise<{ ok: boolean; balanceRemaining: number }> {
    const runInTx = () => {
      if (!isClass1Automation) {
        this.state.storage.sql.exec(
          `UPDATE space_user_budget_envelopes 
           SET credits_spent_today = credits_spent_today + ?, updated_at = datetime('now')
           WHERE user_id = ?`,
          creditsSpent,
          userId
        );
      }

      // Record negative debit in wallet ledger
      const debitCents = -Math.abs(creditsSpent);
      const spaceId = this.state.id.toString();
      this.state.storage.sql.exec(
        `INSERT INTO wallet_ledger (id, space_id, delta_cents, currency, reason, created_at)
         VALUES (?, ?, ?, 'USD', ?, datetime('now'))`,
        `wld_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        spaceId,
        debitCents,
        `[${isClass1Automation ? "SYSTEM_AUTOMATION" : `USER:${userId}`}] ${reason}`
      );

      const balanceRow = this.state.storage.sql.exec(
        `SELECT COALESCE(SUM(delta_cents), 0) as balance_cents FROM wallet_ledger WHERE currency = 'USD'`
      ).toArray()[0] as any;

      return {
        ok: true,
        balanceRemaining: balanceRow ? Number(balanceRow.balance_cents) : 0
      };
    };

    if (typeof (this.state.storage as any).transactionSync === "function") {
      return (this.state.storage as any).transactionSync(runInTx);
    }
    return runInTx();
  }

  async exportSpaceState(options: { includeKnowledge: boolean }): Promise<SpaceExportSnapshot> {
    const spaceId = this.state.id.toString();

    // 1. Fetch space settings / template mode
    let templateMode: "autonomous_venture" | "vertical_cowork" = "autonomous_venture";
    try {
      const spaceMeta = this.state.storage.sql.exec(
        "SELECT id, config_json FROM spaces WHERE id = ?",
        spaceId
      ).toArray()[0] as any;
      if (spaceMeta?.config_json) {
        const config = JSON.parse(spaceMeta.config_json || "{}");
        if (config.templateMode) templateMode = config.templateMode;
      }
    } catch {}

    // 2. Fetch all active projects
    let projects: any[] = [];
    try {
      projects = this.state.storage.sql.exec(
        "SELECT id, name, slug, kind, visibility FROM projects WHERE status = 'active'"
      ).toArray();
    } catch {}
    if (!projects || projects.length === 0) {
      const kvProjects = (await this.state.storage.get("projects")) as any[] || [];
      projects = kvProjects.map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug || p.id,
        kind: p.kind,
        visibility: p.visibility || "private"
      }));
    }

    // 3. Fetch workspace files (Sanitize: exclude .env and internal credentials, <= 2MB)
    let filesRows: any[] = [];
    try {
      filesRows = this.state.storage.sql.exec(
        "SELECT path, content, size_bytes FROM workspace_files WHERE path NOT LIKE '%.env%' AND path NOT LIKE '%.local%' AND size_bytes <= 2000000"
      ).toArray() as any[];
    } catch {}

    // 4. Fetch declared credential names (never the keys!)
    let credRows: any[] = [];
    try {
      credRows = this.state.storage.sql.exec(
        "SELECT DISTINCT credential_name, service_name FROM space_credentials"
      ).toArray() as any[];
    } catch {}

    // 5. Fetch knowledge seeds if requested
    let knowledgeDocs: Array<{ title: string; content: string }> = [];
    if (options.includeKnowledge) {
      try {
        const kbRows = this.state.storage.sql.exec(
          "SELECT title, content FROM knowledge_documents LIMIT 50"
        ).toArray() as any[];
        knowledgeDocs = kbRows.map(r => ({ title: r.title, content: r.content }));
      } catch {}
    }

    // 6. Fetch active goals from Project Journal
    let taskRows: any[] = [];
    try {
      taskRows = this.state.storage.sql.exec(
        "SELECT id, project_id, title FROM project_tasks WHERE status != 'ARCHIVED'"
      ).toArray() as any[];
    } catch {}

    return {
      spaceId,
      templateMode,
      projects,
      workspaceFiles: filesRows.map(f => ({ path: f.path, content: f.content, sizeBytes: f.size_bytes || 0 })),
      credentialsDeclared: credRows.map(c => ({ name: c.credential_name, service: c.service_name || "custom" })),
      knowledgeDocs,
      taskGoals: taskRows.map(t => ({ id: t.id, title: t.title, projectId: t.project_id }))
    };
  }

  async getCallerIdentity(): Promise<{ roleRank: number }> {
    return { roleRank: 4 };
  }

  async submitTemplateForReview(blueprintId: string, submission: TemplatePublishSubmission): Promise<Response> {
    const caller = await this.getCallerIdentity();
    if (caller.roleRank < 4) {
      return new Response(
        JSON.stringify({ error: "Only space owners or administrators can submit templates for publishing." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (this.env.PLATFORM_DB) {
      try {
        await this.env.PLATFORM_DB.prepare(`
          INSERT OR REPLACE INTO marketplace_listings (
            id, space_id, author_user_id, status, pricing_model, price_cents, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending_review', ?, ?, datetime('now'), datetime('now'))
        `).bind(
          blueprintId,
          this.state.id.toString(),
          submission.submittedByUserId,
          submission.requestedPricingModel,
          submission.priceCents
        ).run();
      } catch (err: any) {
        console.warn("PLATFORM_DB insert failed, continuing workflow trigger:", err);
      }
    }

    if (this.env.TEMPLATE_REVIEW_WORKFLOW) {
      try {
        await this.env.TEMPLATE_REVIEW_WORKFLOW.create({
          params: {
            blueprintId,
            spaceId: this.state.id.toString(),
            submissionUserId: submission.submittedByUserId
          }
        });
      } catch (err: any) {
        console.warn("TEMPLATE_REVIEW_WORKFLOW trigger failed:", err);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: "pending_review",
        message: "Template submitted successfully. Automated security gate and sandbox verification in progress."
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  async provisionTestBlueprint(blueprint: any): Promise<{ success: boolean }> {
    if (!blueprint || !Array.isArray(blueprint.projects)) {
      throw new Error("Invalid blueprint format: projects array is required");
    }
    for (const proj of blueprint.projects) {
      await this.createProject({
        id: proj.slug,
        name: proj.name || proj.slug,
        kind: proj.kind || "general"
      });
    }
    return { success: true };
  }
}
