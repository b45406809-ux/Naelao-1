import { deterministicScore, SystemOneDecisionClient, type FastDecisionGateway, type FastDecisionProvider, type SpaceBlueprint } from "@naelao/agent-sdk";
import { getDOName } from "@naelao/crypto";
import type { Context, Hono } from "hono";
import { createBusinessForEndUser } from "../business-create.js";
import { createSpaceRecord } from "../create-space.js";
import type { Env } from "../index.js";

export interface MarketSignal {
  id: string;
  name: string;
  search_surge_pct: number;
  saturation_index: number;
  arr_low_cents: number;
  arr_high_cents: number;
  source_url: string;
  observed_at: string;
}

/** Jev-style System 1 scoring: deterministic, bounded, and fast enough for every radar refresh. */
export function scoreMarketSignal(
  signal: Pick<MarketSignal, "search_surge_pct" | "saturation_index">
): number {
  const velocity = Math.max(0, Math.min(300, signal.search_surge_pct)) / 3;
  const whitespace = 100 - Math.max(0, Math.min(100, signal.saturation_index));
  return deterministicScore(Math.round((velocity * 0.62 + whitespace * 0.38) * 100) / 100, "market_velocity_whitespace_v1").value;
}

export async function scoreMarketSignalWithSentry(
  signal: Pick<MarketSignal, "search_surge_pct" | "saturation_index">,
  gateway?: FastDecisionGateway,
): Promise<{ score: number; provider: FastDecisionProvider }> {
  const fallback = scoreMarketSignal(signal);
  if (!gateway) return { score: fallback, provider: "deterministic" };
  try {
    const decision = await gateway.score({
      state: {
        search_surge_pct: signal.search_surge_pct,
        saturation_index: signal.saturation_index,
      },
      instructions: "Score the market opportunity from weak to exceptional using demand velocity and unsaturated whitespace. Return only the typed score.",
      criteria: ["weak", "very low", "low", "below average", "average", "above average", "good", "strong", "very strong", "exceptional"],
      policyCode: "market_radar_opportunity_v1",
    });
    if ((decision.confidence ?? 0) < 0.75) return { score: fallback, provider: "deterministic" };
    return { score: Math.round((decision.value * 100 / 9) * 100) / 100, provider: decision.provider };
  } catch {
    return { score: fallback, provider: "deterministic" };
  }
}

const STACKS: Record<
  string,
  {
    extensions: string[];
    projects: Array<{ name: string; kind: string; tasks: string[] }>;
  }
> = {
  solar_permitting: {
    extensions: ["ext_crm_core", "ext_docs_core"],
    projects: [
      {
        name: "Permit Operations",
        kind: "operations",
        tasks: [
          "Import jurisdiction requirements",
          "Qualify the first solar project",
          "Assemble permit packet",
        ],
      },
    ],
  },
  med_spa_voice_desk: {
    extensions: ["ext_voice_core", "ext_calendar_core"],
    projects: [
      {
        name: "Voice Front Desk",
        kind: "voice_agent",
        tasks: [
          "Configure treatment catalogue",
          "Connect appointment calendar",
          "Review first call",
        ],
      },
    ],
  },
  cross_border_freight: {
    extensions: ["ext_logistics_core", "ext_research_core"],
    projects: [
      {
        name: "Tariff Radar",
        kind: "research",
        tasks: [
          "Define trade lanes",
          "Load tariff sources",
          "Publish daily exception brief",
        ],
      },
    ],
  },
  dental_claims: {
    extensions: ["ext_healthcare_core", "ext_docs_core"],
    projects: [
      {
        name: "Claims Desk",
        kind: "operations",
        tasks: [
          "Configure payer rules",
          "Import rejected claims",
          "Review appeal queue",
        ],
      },
    ],
  },
  property_compliance: {
    extensions: ["ext_property_core", "ext_calendar_core"],
    projects: [
      {
        name: "Compliance Desk",
        kind: "operations",
        tasks: [
          "Import property register",
          "Map inspection deadlines",
          "Schedule first compliance run",
        ],
      },
    ],
  },
};

export function blueprintForOpportunity(
  signal: Pick<MarketSignal, "id" | "name">
): SpaceBlueprint {
  const stack = STACKS[signal.id];
  if (!stack) throw new Error("Unknown market opportunity");
  return {
    id: `radar-${signal.id}-v1`,
    schemaVersion: "2.0",
    metadata: { name: signal.name, source: "live-market-radar" },
    templateCategory: "venture",
    requiredExtensions: stack.extensions,
    requiredCredentials: [],
    projects: stack.projects.map((project) => ({
      name: project.name,
      kind: project.kind,
      templateMode: "autonomous_venture_os",
      viewports: { primary: "operations_board", secondary: "assistant" },
      systemPrompt: `Operate the ${signal.name} venture. Verify external facts before action and escalate regulated decisions.`,
      initialTasks: project.tasks.map((title, index) => ({
        id: `task-${index + 1}`,
        title,
        status: "pending",
        dependencies: index ? [`task-${index}`] : [],
      })),
      starterFiles: [
        {
          path: "README.md",
          content: `# ${signal.name}\n\nPre-seeded by the Live Market Radar.`,
        },
      ],
      configuration: { executionCeiling: 3 },
    })),
  };
}

export function registerMarketRadarRoutes(app: Hono<{ Bindings: Env }>): void {
  const topTrends = async (c: Context<{ Bindings: Env }>) => {
    const { results } = await c.env.PLATFORM_DB.prepare(
      `SELECT id, name, search_surge_pct, saturation_index, arr_low_cents, arr_high_cents, source_url, observed_at
       FROM market_radar_signals WHERE verified = 1 AND observed_at >= datetime('now', '-30 days')`
    ).all<MarketSignal>();
    const gateway = c.env.TYPESAFE_API_KEY || c.env.SYSTEM_ONE_ENDPOINT
      ? new SystemOneDecisionClient({
          ...(c.env.SYSTEM_ONE_ENDPOINT ? { endpoint: c.env.SYSTEM_ONE_ENDPOINT } : {}),
          ...(c.env.TYPESAFE_API_KEY ? { apiKey: c.env.TYPESAFE_API_KEY } : {}),
          ...(c.env.SYSTEM_ONE_MODEL ? { model: c.env.SYSTEM_ONE_MODEL } : {}),
          provider: c.env.SYSTEM_ONE_PROVIDER ?? (c.env.SYSTEM_ONE_ENDPOINT ? "laya" : "jev"),
          ...(c.env.ANALYTICS ? { onDecision: (event) => {
            try {
              c.env.ANALYTICS!.writeDataPoint({
                blobs: ["system_one.decision", c.req.header("x-naelao-tenant-id") ?? "", c.req.param("productSpaceId") ?? "", "", "market-radar", event.provider, "spaces", event.policyCode, event.model],
                doubles: [event.latencyMs, event.usage.inputTokens, event.usage.outputTokens],
                indexes: [c.req.header("x-naelao-tenant-id") ?? "platform"],
              });
            } catch { /* scoring must not depend on telemetry */ }
          } } : {}),
        })
      : undefined;
    const scored = await Promise.all(results.map(async (signal) => ({
        ...signal,
        ...await scoreMarketSignalWithSentry(signal, gateway),
        saturation_label:
          signal.saturation_index <= 25
            ? "Blue Ocean"
            : signal.saturation_index <= 55
              ? "Emerging"
              : "Competitive",
        preconfigured_stack: STACKS[signal.id]?.extensions ?? [],
        blueprint: blueprintForOpportunity(signal),
      })));
    const opportunities = scored
      .filter((item) => item.preconfigured_stack.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return c.json({
      data: opportunities,
      count: opportunities.length,
      generated_at: new Date().toISOString(),
      scoring_engine: opportunities.some((item) => item.provider !== "deterministic")
        ? "jev-laya-system-1"
        : "deterministic-system-1",
    });
  };
  app.get("/spaces/market-radar/top-trends", topTrends);
  app.get("/spaces/:productSpaceId/market-radar/top-trends", topTrends);

  const launch = async (c: Context<{ Bindings: Env }>) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const userId = c.req.header("x-naelao-user-id") ?? "";
    if (!tenantId)
      return c.json(
        { error_code: "unauthorized", message: "Missing tenant" },
        401
      );
    const signal = await c.env.PLATFORM_DB.prepare(
      "SELECT id, name FROM market_radar_signals WHERE id = ? AND verified = 1"
    )
      .bind(c.req.param("opportunityId"))
      .first<MarketSignal>();
    if (!signal || !STACKS[signal.id])
      return c.json(
        { error_code: "not_found", message: "Market opportunity not found" },
        404
      );
    const body: { name?: string; spacetype_id?: string } = await c.req
      .json<{ name?: string; spacetype_id?: string }>()
      .catch(() => ({}));
    const blueprint = blueprintForOpportunity(signal);
    const productSpaceId = c.req.param("productSpaceId");
    let spaceId: string;
    let spaceTenantId = tenantId;
    if (productSpaceId) {
      if (!userId)
        return c.json(
          { error_code: "unauthorized", message: "Missing user" },
          401
        );
      const created = await createBusinessForEndUser(c.env, {
        resellerProductSpaceId: productSpaceId,
        userId,
        name: body.name?.trim() || signal.name,
        spacetypeId: body.spacetype_id ?? "launchpad",
      });
      if (!created.ok)
        return c.json(
          { error_code: created.error_code, message: created.message },
          created.status
        );
      spaceId = created.spaceId;
      spaceTenantId = created.tenantId;
    } else {
      const created = await createSpaceRecord(c.env, {
        tenantId,
        ...(userId ? { userId } : {}),
        name: body.name?.trim() || signal.name,
        spacetypeId: body.spacetype_id ?? "launchpad",
      });
      spaceId = created.id;
    }
    const doId = c.env.SPACE_DO.idFromName(
      await getDOName("space", spaceId, spaceTenantId, c.env.PLATFORM_SECRET)
    );
    const installed = await c.env.SPACE_DO.get(doId).fetch(
      new Request("http://space-do/blueprints/instantiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blueprint, target_space_id: spaceId }),
      })
    );
    if (!installed.ok)
      return c.json(
        {
          error_code: "blueprint_instantiation_failed",
          details: await installed.text(),
          space_id: spaceId,
        },
        500
      );
    return c.json(
      {
        space_id: spaceId,
        opportunity_id: signal.id,
        blueprint_id: blueprint.id,
        installation: await installed.json(),
      },
      201
    );
  };
  app.post("/spaces/market-radar/:opportunityId/launch", launch);
  app.post(
    "/spaces/:productSpaceId/market-radar/:opportunityId/launch",
    launch
  );
}
