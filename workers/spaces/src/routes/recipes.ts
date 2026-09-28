import { RECIPE_CATALOG, getRecipe } from "@naelao/agent-sdk";
import { getDOName } from "@naelao/crypto";
import type { Hono } from "hono";

interface RecipeEnv {
  PLATFORM_DB: D1Database;
  PLATFORM_SECRET: string;
  SPACE_DO: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  };
}

async function projectStub(
  env: RecipeEnv,
  spaceId: string,
  tenantId: string
): Promise<DurableObjectStub> {
  const id = env.SPACE_DO.idFromName(
    await getDOName("space", spaceId, tenantId, env.PLATFORM_SECRET)
  );
  return env.SPACE_DO.get(id);
}

export function registerRecipeRoutes<T extends RecipeEnv>(
  app: Hono<{ Bindings: T }>
): void {
  app.get("/recipes", (c) =>
    c.json({ recipes: Object.values(RECIPE_CATALOG) })
  );

  app.post(
    "/spaces/:spaceId/projects/:projectId/recipes/:recipeId/install",
    async (c) => {
      const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
      const userId = c.req.header("x-naelao-user-id") ?? "";
      if (!tenantId || !userId)
        return c.json(
          {
            error_code: "unauthorized",
            message: "Authenticated tenant and user are required",
          },
          401
        );

      const recipe = getRecipe(c.req.param("recipeId"));
      if (!recipe)
        return c.json(
          { error_code: "not_found", message: "Recipe not found" },
          404
        );
      const spaceId = c.req.param("spaceId");
      const projectId = c.req.param("projectId");
      const owned = await c.env.PLATFORM_DB.prepare(
        "SELECT id FROM spaces WHERE id = ? AND tenant_id = ? AND status != 'deleted'"
      )
        .bind(spaceId, tenantId)
        .first();
      if (!owned)
        return c.json(
          { error_code: "not_found", message: "Space not found" },
          404
        );

      const stub = await projectStub(c.env, spaceId, tenantId);
      const access = await stub.fetch(
        new Request(
          `http://space-do/projects/${encodeURIComponent(projectId)}/automation-access?space_id=${encodeURIComponent(spaceId)}&user_id=${encodeURIComponent(userId)}`
        )
      );
      if (!access.ok)
        return new Response(access.body, {
          status: access.status,
          headers: { "content-type": "application/json" },
        });

      // Setting kind=customer_bot makes the existing project execute inside CustomerBotContext;
      // a conservative ceiling prevents a support-channel prompt from reaching containers.
      const patch =
        recipe.projectKind === "customer_bot"
          ? {
              kind: "customer_bot",
              execution_ceiling: 2,
              channel_config: {
                recipe_id: recipe.id,
                runtime_context: recipe.runtimeContext,
              },
            }
          : { kind: "workspace" };
      const configured = await stub.fetch(
        new Request(
          `http://space-do/projects/${encodeURIComponent(projectId)}?tenant_id=${encodeURIComponent(tenantId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          }
        )
      );
      if (!configured.ok)
        return new Response(configured.body, {
          status: configured.status,
          headers: { "content-type": "application/json" },
        });

      const installationId = `recipe:${spaceId}:${projectId}:${recipe.id}`;
      await c.env.PLATFORM_DB.prepare(
        `INSERT INTO recipe_installations (id, space_id, project_id, recipe_id, recipe_config_json, installed_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(space_id, project_id, recipe_id) DO UPDATE SET
         recipe_config_json = excluded.recipe_config_json, installed_by = excluded.installed_by,
         updated_at = datetime('now')`
      )
        .bind(
          installationId,
          spaceId,
          projectId,
          recipe.id,
          JSON.stringify(recipe),
          userId
        )
        .run();
      return c.json(
        {
          installed: true,
          installation_id: installationId,
          space_id: spaceId,
          project_id: projectId,
          recipe,
        },
        201
      );
    }
  );
}
