import {
  GadgetInstanceRecord,
  GadgetTier,
  InstallGadgetParams,
  ResolveGadgetRosterParams,
  GadgetRosterItem,
} from "@avos/types";

export interface Env {
  MICRO_APP_DO: DurableObjectNamespace;
  DB?: D1Database;
}

/**
 * Computes deterministic MicroApp DO addressing name based on Tier invariants:
 * - Tier 1 (Personal): `t1:${spaceId}:${userId}:${slug}`
 * - Tier 2/3 (Project/Background): `t${tier}:${spaceId}:${projectId}:${slug}`
 */
export function computeMicroAppDoName(
  tier: GadgetTier,
  spaceId: string,
  projectId: string | null | undefined,
  userId: string | null | undefined,
  slug: string
): string {
  if (tier === 1) {
    if (!userId) {
      throw new Error("Tier 1 Personal Gadgets require ownerUserId.");
    }
    return `t1:${spaceId}:${userId}:${slug}`;
  } else {
    if (!projectId) {
      throw new Error("Tier 2/3 Project Gadgets require projectId.");
    }
    return `t${tier}:${spaceId}:${projectId}:${slug}`;
  }
}

export class SpaceDO {
  private state: DurableObjectState;
  private env: Env;
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;

    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS gadget_instances (
        id TEXT PRIMARY KEY,
        manifest_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        tier INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
        space_id TEXT NOT NULL,
        project_id TEXT,
        owner_user_id TEXT,
        config_json TEXT DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hibernating', 'archived')),
        storage_usage_bytes INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(space_id, project_id, owner_user_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_gadget_lookup ON gadget_instances(space_id, project_id, owner_user_id);
    `);

    this.initialized = true;
  }

  public async installGadget(params: InstallGadgetParams): Promise<GadgetInstanceRecord> {
    await this.ensureInit();

    const {
      manifestId,
      slug,
      tier,
      spaceId,
      projectId = null,
      ownerUserId = null,
      configJson = "{}",
    } = params;

    // Validate tier scoping invariants
    if (tier === 1) {
      if (!ownerUserId) {
        throw new Error("Tier 1 (Personal Task Gadget) requires ownerUserId.");
      }
    } else {
      if (!projectId) {
        throw new Error(`Tier ${tier} Gadget requires a valid projectId.`);
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const normalizedProjectId = tier === 1 ? null : projectId;
    const normalizedOwnerUserId = tier === 1 ? ownerUserId : null;

    this.state.storage.sql.exec(
      `INSERT INTO gadget_instances (
        id, manifest_id, slug, tier, space_id, project_id, owner_user_id, config_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(space_id, project_id, owner_user_id, slug) DO UPDATE SET
        manifest_id = excluded.manifest_id,
        config_json = excluded.config_json,
        status = 'active',
        updated_at = excluded.updated_at`,
      id,
      manifestId,
      slug,
      tier,
      spaceId,
      normalizedProjectId,
      normalizedOwnerUserId,
      configJson,
      now,
      now
    );

    const record = await this.getGadgetBySlug(spaceId, slug, normalizedProjectId, normalizedOwnerUserId);
    if (!record) {
      throw new Error("Failed to retrieve installed gadget record.");
    }
    return record;
  }

  public async getGadgetBySlug(
    spaceId: string,
    slug: string,
    projectId: string | null,
    ownerUserId: string | null
  ): Promise<GadgetInstanceRecord | null> {
    await this.ensureInit();

    const cursor = this.state.storage.sql.exec(
      `SELECT * FROM gadget_instances 
       WHERE space_id = ? AND slug = ? 
         AND (project_id IS ? OR project_id = ?)
         AND (owner_user_id IS ? OR owner_user_id = ?)
       LIMIT 1`,
      spaceId,
      slug,
      projectId,
      projectId,
      ownerUserId,
      ownerUserId
    );

    const rows = [...cursor];
    if (rows.length === 0) return null;
    return this.mapRowToRecord(rows[0] as Record<string, unknown>);
  }

  public async listGadgets(filter?: {
    spaceId?: string;
    projectId?: string | null;
    userId?: string | null;
    tier?: GadgetTier;
  }): Promise<GadgetInstanceRecord[]> {
    await this.ensureInit();

    let query = `SELECT * FROM gadget_instances WHERE 1=1`;
    const params: (string | number | null)[] = [];

    if (filter?.spaceId) {
      query += ` AND space_id = ?`;
      params.push(filter.spaceId);
    }
    if (filter?.projectId !== undefined) {
      if (filter.projectId === null) {
        query += ` AND project_id IS NULL`;
      } else {
        query += ` AND project_id = ?`;
        params.push(filter.projectId);
      }
    }
    if (filter?.userId !== undefined) {
      if (filter.userId === null) {
        query += ` AND owner_user_id IS NULL`;
      } else {
        query += ` AND owner_user_id = ?`;
        params.push(filter.userId);
      }
    }
    if (filter?.tier !== undefined) {
      query += ` AND tier = ?`;
      params.push(filter.tier);
    }

    query += ` ORDER BY created_at ASC`;

    const cursor = this.state.storage.sql.exec(query, ...params);
    return [...cursor].map((row) => this.mapRowToRecord(row as Record<string, unknown>));
  }

  /**
   * Resolves the "Effective Roster" of tools available to an agent or user
   * based on their current project and personal identity:
   * - Select Tier 1 gadgets owned by userId in this space
   * - Select Tier 2/3 gadgets bound to projectId in this space
   */
  public async resolveGadgetRoster(
    params: ResolveGadgetRosterParams
  ): Promise<GadgetRosterItem[]> {
    await this.ensureInit();

    const { spaceId, projectId, userId } = params;

    const query = `
      SELECT * FROM gadget_instances
      WHERE space_id = ?
        AND status = 'active'
        AND (
          (tier = 1 AND owner_user_id = ?)
          OR
          (tier IN (2, 3) AND project_id = ?)
        )
      ORDER BY tier ASC, created_at ASC
    `;

    const cursor = this.state.storage.sql.exec(
      query,
      spaceId,
      userId ?? null,
      projectId ?? null
    );

    const rows = [...cursor];
    const items: GadgetRosterItem[] = [];

    for (const row of rows) {
      const record = this.mapRowToRecord(row as Record<string, unknown>);
      const doName = computeMicroAppDoName(
        record.tier,
        record.spaceId,
        record.projectId,
        record.ownerUserId,
        record.slug
      );
      const doId = this.env.MICRO_APP_DO.idFromName(doName).toString();

      items.push({
        instance: {
          ...record,
          doName,
        },
        microAppDoName: doName,
        microAppDoId: doId,
      });
    }

    return items;
  }

  private mapRowToRecord(row: Record<string, unknown>): GadgetInstanceRecord {
    return {
      instanceId: String(row.id),
      manifestId: String(row.manifest_id),
      slug: String(row.slug),
      tier: Number(row.tier) as GadgetTier,
      spaceId: String(row.space_id),
      projectId: row.project_id ? String(row.project_id) : null,
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      configJson: String(row.config_json || "{}"),
      status: String(row.status) as GadgetInstanceRecord["status"],
      storageUsageBytes: Number(row.storage_usage_bytes || 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureInit();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/install")) {
      try {
        const body = (await request.json()) as InstallGadgetParams;
        const installed = await this.installGadget(body);
        return new Response(JSON.stringify(installed), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: msg }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (request.method === "POST" && url.pathname.endsWith("/roster")) {
      try {
        const body = (await request.json()) as ResolveGadgetRosterParams;
        const roster = await this.resolveGadgetRoster(body);
        return new Response(JSON.stringify(roster), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: msg }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (request.method === "GET" && url.pathname.endsWith("/list")) {
      const spaceId = url.searchParams.get("spaceId") || undefined;
      const projectId = url.searchParams.has("projectId") ? url.searchParams.get("projectId") : undefined;
      const userId = url.searchParams.has("userId") ? url.searchParams.get("userId") : undefined;
      const tierParam = url.searchParams.get("tier");
      const tier = tierParam ? (Number(tierParam) as GadgetTier) : undefined;

      const list = await this.listGadgets({ spaceId, projectId, userId, tier });
      return new Response(JSON.stringify(list), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not Found in SpaceDO" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}
