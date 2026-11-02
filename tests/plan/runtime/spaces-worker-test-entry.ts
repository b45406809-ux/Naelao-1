import { getDOName } from "@naelao/crypto";
import spacesWorker, { SpaceDO as BaseSpaceDO } from "../../../workers/spaces/src/index.js";

/** Test-only bulk fixture seeding keeps the scale experiment on the real local SpaceDO. */
class RuntimeTestSpaceDO extends BaseSpaceDO {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/seed-blackboard-projects" && request.method === "POST") {
      const body = await request.json<{ spaceId?: string; count?: number }>().catch(() => ({}));
      const spaceId = body.spaceId ?? "";
      const count = body.count ?? 0;
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(spaceId) || !Number.isInteger(count) || count < 1 || count > 10_000)
        return Response.json({ error_code: "invalid_scale_seed" }, { status: 400 });

      // Force the normal initialization/migration path before inserting controlled test rows.
      const initialized = await super.fetch(new Request(`http://space-do/projects?space_id=${encodeURIComponent(spaceId)}`));
      if (!initialized.ok) return Response.json({ error_code: "space_do_initialization_failed", status: initialized.status }, { status: 500 });

      const sql = (this as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      const projectIds: string[] = [];
      const columns = "id,space_id,subspace_id,name,description,status,kind,is_singleton_kind,default_agent_id,max_threads,allowed_agent_ids,visibility,created_by,created_at,lifecycle,execution_ceiling,template_mode,viewport_config";
      const row = "(?,?,NULL,?,'','active','DualPane',0,NULL,0,NULL,'public',NULL,?,'finite',5,'cowork_studio','{}')";
      // Workerd's embedded SQLite has a smaller bind-variable ceiling than local desktop builds.
      for (let offset = 0; offset < count; offset += 20) {
        const batchCount = Math.min(20, count - offset);
        const values: Array<string | number> = [];
        const placeholders: string[] = [];
        for (let index = offset; index < offset + batchCount; index++) {
          const projectId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
          projectIds.push(projectId);
          placeholders.push(row);
          values.push(projectId, spaceId, `blackboard-scale-${String(index).padStart(5, "0")}`, "2026-11-02T00:00:00.000Z");
        }
        sql.exec(`INSERT OR REPLACE INTO projects(${columns}) VALUES ${placeholders.join(",")}`, ...values);
      }
      return Response.json({ seeded_projects: projectIds.length, first_project_id: projectIds[0], last_project_id: projectIds.at(-1) });
    }
    return super.fetch(request);
  }
}

export { RuntimeTestSpaceDO as SpaceDO };

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/__runtime_ready")
      return Response.json({ ok: true });
    if (url.pathname === "/__test/blackboard-scale-seed" && request.method === "POST") {
      const body = await request.json<{ tenantId?: string; spaceId?: string; count?: number }>().catch(() => ({}));
      const tenantId = body.tenantId ?? "";
      const spaceId = body.spaceId ?? "";
      const count = body.count ?? 0;
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(tenantId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(spaceId) || !Number.isInteger(count) || count < 1 || count > 10_000)
        return Response.json({ error_code: "invalid_scale_seed" }, { status: 400 });
      const secret = String(env.PLATFORM_SECRET ?? "");
      const namespace = env.SPACE_DO as DurableObjectNamespace;
      const stub = namespace.get(namespace.idFromName(await getDOName("space", spaceId, tenantId, secret)));
      const projectsResponse = await stub.fetch(new Request("http://space-do/__test/seed-blackboard-projects", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spaceId, count }),
      }));
      const projects = await projectsResponse.json().catch(() => null) as { seeded_projects?: number; error_code?: string } | null;
      if (!projectsResponse.ok || projects?.seeded_projects !== count)
        return Response.json({ error_code: projects?.error_code ?? "project_fixture_seed_failed", status: projectsResponse.status }, { status: 500 });

      const db = env.PLATFORM_DB as D1Database;
      const timestamp = new Date().toISOString();
      for (let offset = 0; offset < count; offset += 100) {
        const statements = [];
        for (let index = offset; index < Math.min(offset + 100, count); index++) {
          const projectId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
          const reference = `ref${String(index).padStart(5, "0")}`;
          statements.push(db.prepare(`INSERT OR REPLACE INTO space_blackboard_cards
            (tenant_id,space_id,project_id,summary,capabilities_json,evidence_json,updated_at) VALUES(?,?,?,?,?,?,?)`)
            .bind(tenantId, spaceId, projectId, `Synthetic shared project reference ${reference}`, "[]", "[]", timestamp));
        }
        await db.batch(statements);
      }
      return Response.json({ seeded_projects: projects.seeded_projects, seeded_cards: count });
    }
    return spacesWorker.fetch(request, env as never, ctx);
  },
};
