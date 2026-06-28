/**
 * ProductDO — Singleton Durable Object for Naelao Whop Businesses product config.
 *
 * Holds: branding, template config, billing entity, signup kill switch.
 * One instance per Naelao deployment (idFromName("product")).
 *
 * Generic shape only — no Whop-Businesses-specific logic lives here.
 * Business logic lives in BusinessDO.
 */

import { DurableObject } from "cloudflare:workers";

interface BrandingConfig {
  name: string;
  logo_url: string | null;
  slug: string;
}

interface BillingEntity {
  stripe_customer_id: string | null;
  whop_company_id: string | null;
}

interface ProductRow {
  key: string;
  value: string;
}

export class ProductDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec("PRAGMA journal_mode=WAL");
    this.ctx.storage.sql.exec("PRAGMA synchronous=NORMAL");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // Seed defaults on first boot
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO config (key, value) VALUES
        ('signup_open', 'true'),
        ('template_id', 'whop-businesses-v1'),
        ('template_version', '1'),
        ('branding', '{"name":"Naelao","logo_url":null,"slug":"naelao"}'),
        ('billing_entity', '{"stripe_customer_id":null,"whop_company_id":null}')
    `);
    this.initialized = true;
  }

  private get(key: string): string | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT value FROM config WHERE key = ?`, key)
      .toArray() as unknown as ProductRow[];
    return rows[0]?.value ?? null;
  }

  private set(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key, value
    );
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // GET /config — full product config
    if (method === "GET" && url.pathname === "/config") {
      return Response.json({
        signup_open: this.get("signup_open") === "true",
        template_id: this.get("template_id"),
        template_version: parseInt(this.get("template_version") ?? "1", 10),
        branding: JSON.parse(this.get("branding") ?? "{}") as BrandingConfig,
        billing_entity: JSON.parse(this.get("billing_entity") ?? "{}") as BillingEntity,
      });
    }

    // PATCH /config — update any writable field
    if (method === "PATCH" && url.pathname === "/config") {
      const body = await request.json<Partial<{
        signup_open: boolean;
        branding: Partial<BrandingConfig>;
        billing_entity: Partial<BillingEntity>;
        template_version: number;
      }>>();

      if (body.signup_open !== undefined) {
        this.set("signup_open", String(body.signup_open));
      }
      if (body.template_version !== undefined) {
        this.set("template_version", String(body.template_version));
      }
      if (body.branding) {
        const current = JSON.parse(this.get("branding") ?? "{}") as BrandingConfig;
        this.set("branding", JSON.stringify({ ...current, ...body.branding }));
      }
      if (body.billing_entity) {
        const current = JSON.parse(this.get("billing_entity") ?? "{}") as BillingEntity;
        this.set("billing_entity", JSON.stringify({ ...current, ...body.billing_entity }));
      }
      return Response.json({ updated: true });
    }

    // POST /signup-gate — returns 403 if signups are closed
    if (method === "GET" && url.pathname === "/signup-gate") {
      const open = this.get("signup_open") === "true";
      if (!open) return Response.json({ allowed: false, reason: "Signups are currently closed" }, { status: 403 });
      return Response.json({ allowed: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
