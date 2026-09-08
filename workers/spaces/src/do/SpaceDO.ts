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
}
