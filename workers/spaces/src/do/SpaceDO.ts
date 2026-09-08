import { AVOS_PROJECT_KINDS } from '../../../../packages/events/src/business-feature-kinds';

export interface Env {
  // Define environment bindings here if needed
}

export class SpaceDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Initialize SQLite storage for active gadget instances
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
   * Returns active gadget instances available for an agent execution run.
   * - Tier 2 (Canvas) & Tier 3 (Background Indexers) are scoped by projectId.
   * - Tier 1 (Personal Task Apps) are scoped by ownerUserId.
   */
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
