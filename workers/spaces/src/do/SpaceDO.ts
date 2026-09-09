import { AVOS_PROJECT_KINDS } from '../../../../packages/events/src/business-feature-kinds';
import type { AvosWorkflowDefinition, WorkflowClass, WorkflowFundingSource, WorkflowAlertChannel } from "@naelao/types";

export interface Env {
  // Define environment bindings here if needed
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
            project_id TEXT,
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
}
